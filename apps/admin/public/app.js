// The Hana admin console SPA (batch C8; reports, statements and rates in C12; retention in C13; Users in C8b; the Support ID lookup in C15): plain JavaScript, no build step and no dependency, under the admin CSP
// (script-src 'self', style-src 'self'). Every value from the API is put in the page as text (textContent), never as
// HTML. Writes send the admin's CSRF headers; Cloudflare Access adds the staff identity at the edge.
//
// UI rules (apps/admin/README.md "UI principles"): the nav is grouped by task; each page has one header with at most
// one primary action; an action that can't work isn't offered (it is hidden or disabled with one line saying why);
// every API error is said in plain words with what to do next, its code kept small for support; anything destructive
// or guarded is confirmed in the page (never a browser dialog); a support reference is explained where it is asked.
'use strict';

// ---- helpers ----

/** An element with attributes and children (strings become text nodes). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** A time as `2026-11-06 04:28 UTC` (staff work across time zones: always UTC, to the minute). */
const time = (ms) => (typeof ms === 'number' ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
/** A short span: `4 min`, `3 h 5 min`, `2 d 4 h`. */
function span(ms) {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.round((abs % 3_600_000) / 60_000);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${mins} min` : `${mins} min`;
}
/** `4 min ago` / `in 2 d 3 h`, from the reader's clock. */
const relative = (ms) => (typeof ms !== 'number' ? '' : ms <= Date.now() ? `${roughly(Date.now() - ms)} ago` : `in ${roughly(ms - Date.now())}`);
/** A span to its largest unit past a day (`20 d`), else as `span`. */
const roughly = (ms) => (ms >= 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} d` : span(ms));
/** A time cell: the UTC time, with how long ago underneath. */
const when = (ms) => (typeof ms === 'number' ? h('span', {}, h('time', { datetime: new Date(ms).toISOString() }, time(ms)), h('span', { class: 'sub' }, relative(ms))) : '');
const link = (path, text) => h('a', { href: path, 'data-link': true }, text);
const mono = (s) => (s === null || s === undefined || s === '' ? '' : h('code', { class: String(s).length <= 30 ? 'nw' : undefined }, String(s)));
/** A name with its id underneath, small (ids stay visible for support, never the headline). */
const named = (name, id) => h('span', {}, name, id ? h('span', { class: 'sub' }, h('code', {}, id)) : '');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * One `/api/*` request, as sent. `redirect: 'manual'`: when the Access session has ended, Cloudflare Access answers
 * with a redirect to its login page on another origin; followed, the browser blocks it (CORS) and the page would see
 * a network error. Not followed, it is an `opaqueredirect` (status 0), told apart from a real network failure (which
 * rejects). Returns the Response, or EXPIRED for that redirect or the Worker's own 401 (no valid Access token).
 */
const EXPIRED = Symbol('expired');
async function send(method, path, bodyText) {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' };
  if (bodyText !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.headers['x-hana-admin'] = '1';
    init.body = bodyText;
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'The browser could not reach the admin console');
  }
  if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400) || res.status === 401) return EXPIRED;
  return res;
}

async function api(method, path, body) {
  // The body is serialised once: a retry after a new sign-in sends exactly these bytes again.
  const bodyText = method !== 'GET' ? JSON.stringify(body || {}) : undefined;
  for (;;) {
    const res = await send(method, path, bodyText);
    if (res === EXPIRED) {
      // Nothing was done: the request waits here (its page and the typed values untouched) until "Try again".
      await session.waitForSignIn();
      continue;
    }
    session.answered();
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'error', data?.error?.message || `HTTP ${res.status}`);
    return data;
  }
}

// ---- the Access sign-in: its end, said before and when it happens ----

/** The warning shows this long before the Access token's `exp` (GET /api/me `accessExp`). */
const WARN_BEFORE_MS = 5 * 60_000;
/** How often the countdown is redrawn (and, past `exp`, the sign-in checked). */
const SESSION_TICK_MS = 15_000;
/** The page "Sign in again" and "Renew" open in a new tab: Access signs the staff member in there; it says what next. */
const SIGNED_IN_PATH = '/signed-in';

const session = {
  /** The Access token's expiry (ms), from GET /api/me; null when unknown. */
  expMs: null,
  /** GET /api/me's `renewUrl`: the Access team login for this app (a fresh token before the end); null: `/signed-in`. */
  renewUrl: null,
  /** The sign-in has ended: a request was redirected to Access or answered 401, or a check past `exp` found it so. */
  expired: false,
  /** A retry or a check still found no sign-in: the banner says so. */
  stillOut: false,
  /** A check found a new sign-in while requests still wait: the banner asks for Try again to send them. */
  back: false,
  /** Set by Renew: the next look at this tab re-reads `exp`, and the banner says what that found. */
  renewing: false,
  /** A Renew didn't move `exp` (Access renews a sign-in only once it has ended). */
  renewKept: false,
  /** "Try again" was pressed: a redirect that follows it means the sign-in still hasn't happened. */
  retried: false,
  /** Requests waiting for a new sign-in: {page, resume, drop}. */
  waiting: [],
  timer: null,
  checking: false,

  /** The sign-in has ended (again): `announce` when this is news (a new alert, read out once). */
  ended() {
    if (this.retried) this.stillOut = true;
    this.retried = false;
    const announce = !this.expired || this.back;
    this.expired = true;
    this.back = false;
    renderSession(announce);
  },

  /** A request found the sign-in ended: it waits until "Try again" (resolves) or a move to another page (rejects). */
  waitForSignIn() {
    return new Promise((resume, drop) => {
      this.waiting.push({ page: location.pathname, resume, drop });
      this.ended();
    });
  },

  /**
   * An answer that isn't a redirect: the sign-in works (again). The banner goes, unless requests still wait: then it
   * says so, and Try again sends them (nothing is sent without it).
   */
  answered() {
    if (!this.expired) return;
    this.stillOut = false;
    this.retried = false;
    if (this.waiting.length) {
      this.back = true;
      renderSession(true);
      return;
    }
    this.expired = false;
    this.back = false;
    renderSession();
    void refreshExp();
  },

  /** "Try again": every waiting request is sent again, exactly as it was; with none waiting, the sign-in is checked. */
  retry() {
    const waiting = this.waiting;
    this.waiting = [];
    this.retried = true;
    if (!waiting.length) return void refreshExp();
    for (const w of waiting) w.resume();
    return undefined;
  },

  /** A move to another page: what was waiting on the old one is never sent later (its form is gone). */
  dropOtherPages(page) {
    if (!this.waiting.some((w) => w.page !== page)) return;
    const keep = [];
    for (const w of this.waiting) {
      if (w.page === page) keep.push(w);
      else w.drop(new ApiError(0, 'session_expired', 'Not sent: the Access sign-in had ended'));
    }
    this.waiting = keep;
    if (this.back && !keep.length) {
      // Signed in again and nothing left to send: the banner goes.
      this.back = false;
      this.expired = false;
    }
    renderSession();
  },
};

/** GET /api/me's `accessExp` (seconds) into the session; returns the `exp` it had before. */
function noteExp(answer) {
  const exp = answer && typeof answer.accessExp === 'number' && Number.isFinite(answer.accessExp) ? answer.accessExp * 1000 : null;
  const before = session.expMs;
  session.expMs = exp;
  const renew = answer && typeof answer.renewUrl === 'string' && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/login\//u.test(answer.renewUrl) ? answer.renewUrl : null;
  if (renew) session.renewUrl = renew;
  if (!session.timer && exp !== null) session.timer = setInterval(tickSession, SESSION_TICK_MS);
  return before;
}

/** Re-reads `exp` (after a new sign-in, a Renew, or `exp` passing on this clock). Never waits for a sign-in. */
async function refreshExp() {
  if (session.checking) return;
  session.checking = true;
  try {
    const res = await send('GET', '/api/me');
    if (res === EXPIRED) {
      session.ended();
      return;
    }
    const before = noteExp(await res.json().catch(() => null));
    if (session.renewing) {
      session.renewing = false;
      session.renewKept = before !== null && session.expMs === before;
    }
    if (session.expired) session.answered();
    else renderSession();
  } catch {
    // Offline: the next tick, or the next look at this tab, checks again.
  } finally {
    session.checking = false;
  }
}

function tickSession() {
  if (session.expMs === null || session.expired) return;
  // At `exp` on this clock the Worker is asked (this clock may be off): Access redirects, or a new `exp` comes back.
  if (Date.now() >= session.expMs) void refreshExp();
  else renderSession();
}

/** Back on this tab (from the sign-in tab): find the new sign-in, or re-read `exp` near its end. */
function onTabBack() {
  if (document.visibilityState === 'hidden') return;
  if (session.expired || session.renewing || (session.expMs !== null && Date.now() >= session.expMs - WARN_BEFORE_MS)) void refreshExp();
}
window.addEventListener('focus', onTabBack);
document.addEventListener('visibilitychange', onTabBack);

/** "Sign in again" / "Renew": a link that opens this console in a new tab, where Access signs the staff member in. */
const signInLink = (label, onOpen, href = SIGNED_IN_PATH) => h('a', { href, target: '_blank', rel: 'noopener', class: 'button primary', onclick: onOpen }, label);

/** The banner above every page: the sign-in's end coming (a warning), or come (an alert). Empty otherwise. */
function renderSession(announce) {
  const host = document.getElementById('session');
  if (!host) return;
  const now = Date.now();
  if (session.back) {
    host.replaceChildren(
      h(
        'div',
        { class: 'session-banner signed-in', role: 'status' },
        h('strong', {}, 'You’re signed in again'),
        h('p', {}, 'Press Try again to send what was waiting: nothing was sent while you were signed out.'),
        h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => session.retry() }, 'Try again')),
      ),
    );
    return;
  }
  if (session.expired) {
    const box = h(
      'div',
      { class: 'session-banner expired', role: 'alert' },
      h('strong', {}, 'Your sign-in has expired'),
      h(
        'p',
        {},
        session.waiting.length
          ? 'Nothing was sent, and everything you typed is still here. Sign in again in the new tab, come back to this tab, then press Try again to send it.'
          : 'Nothing on this page is lost. Sign in again in the new tab, then come back to this tab and press Try again.',
      ),
      session.stillOut ? h('p', { class: 'still' }, 'Still signed out: finish signing in in the other tab (Sign in again opens it), then press Try again.') : '',
      h('div', { class: 'form-actions' }, signInLink('Sign in again'), h('button', { type: 'button', onclick: () => session.retry() }, 'Try again')),
    );
    // A new alert is announced; a changed one replaces its text in place (no second announcement for the same end).
    if (announce || !host.firstChild || !host.firstChild.classList.contains('expired')) host.replaceChildren(box);
    else if (host.firstChild.textContent !== box.textContent) host.firstChild.replaceChildren(...box.childNodes);
    return;
  }
  if (session.expMs !== null && session.expMs - now <= WARN_BEFORE_MS) {
    const mins = Math.max(1, Math.ceil((session.expMs - now) / 60_000));
    const box = h(
      'div',
      { class: 'session-banner ending', role: 'status' },
      h('strong', {}, `Your sign-in ends in ${mins} min`),
      h(
        'p',
        {},
        session.renewKept
          ? `Cloudflare Access kept your current sign-in: it still ends at ${time(session.expMs)}. Access renews a sign-in only once it has ended; when it does, sign in again from here, and nothing you typed is lost.`
          : `At ${time(session.expMs)}. Renew opens the console in a new tab to sign in again; this tab and what you typed stay as they are.`,
      ),
      h(
        'div',
        { class: 'form-actions' },
        signInLink(
          'Renew',
          () => {
            session.renewing = true;
            session.renewKept = false;
          },
          // The team login issues a fresh token now; a plain visit wouldn't (Access keeps an unexpired one).
          session.renewUrl ?? SIGNED_IN_PATH,
        ),
      ),
    );
    // Redrawn only when its words change (a live region reads out each change).
    if (!host.firstChild || !host.firstChild.classList.contains('ending')) host.replaceChildren(box);
    else if (host.firstChild.textContent !== box.textContent) host.firstChild.replaceChildren(...box.childNodes);
    return;
  }
  session.renewKept = false;
  host.replaceChildren();
}

// ---- errors in plain words ----

const LEGACY_ORG = 'org_legacy';
const LEGACY_HINT = 'Legacy apps holds the scopes from before organisations existed. To onboard a partner, invite their first owner to a new organisation (Organisations, "Invite a new partner"), then use “Move to an organisation” on their scope in Legacy apps.';

/** Every code the admin API answers (docs/api.md "Admin Worker"): what happened, and what to do next. */
const ERRORS = {
  network: ['Can’t reach the admin console', 'Check your connection and try again. If your Access session expired, reload the page to sign in again.'],
  session_expired: ['Not sent: your sign-in had expired', 'Nothing was changed. Sign in again (the banner at the top), then do it again.'],
  unauthenticated: ['Your sign-in has expired', 'Reload the page to sign in through Cloudflare Access again.'],
  not_staff: ['This account isn’t on the Hana staff list', 'Sign in with your Hana staff account. A founder adds staff to the environment’s staff list.'],
  csrf: ['The browser’s same-origin check failed', 'Reload the page and try again. If it keeps happening, turn off browser extensions that change requests.'],
  access_unavailable: ['Cloudflare Access can’t be checked right now', 'Try again in a minute.'],
  upstream_unavailable: ['A Hana service didn’t answer', 'Nothing was changed. Try again in a minute; if it keeps failing, check the API and console Workers.'],
  ledger_unavailable: ['The usage ledger isn’t available', 'Reports, statements, rates and exports need the usage ledger. In an environment without usage capture this is expected.'],
  not_found: ['Not found', 'It may have been deleted, or the page is out of date. Go back and reload the list.'],
  bad_request: ['Check what you entered', 'The details say which field the server refused. Fix it and try again.'],
  forbidden: ['That isn’t allowed here', 'The details say why. Nothing was changed.'],
  not_owner: ['Only an owner can do that', 'Nothing was changed.'],
  version_conflict: ['Someone changed this first', 'Reload the page to see the latest version, then try again.'],
  already_applied: ['That’s already done', 'Reload the page to see the current state.'],
  token_used: ['That link was already used', 'Reload the page to see the current state.'],
  scope_conflict: ['The scope doesn’t fit this organisation', 'If the scope has Google-account owners on chain, each must be an owner of that organisation first (scopes owned only by a NEAR account move freely). The scope must also be registered on chain and not belong to another organisation. The details say which.'],
  not_pending: ['This is no longer pending', 'It was applied, cancelled or expired. Reload the page to see it.'],
  conflict: ['That clashes with the current state', 'The details say what clashes. Reload the page and try again if it still applies.'],
  key_limit: ['This app has as many keys as it can have', 'Revoke an old key first.'],
  no_security_contact: ['This organisation has no security contact', 'Add at least one security contact on the organisation’s page first.'],
  env_mismatch: ['Test and live don’t match', 'The scope is registered for the other environment: choose that environment.'],
  origin_refused: ['That origin isn’t accepted', 'Use a full https:// origin with no path, for example https://app.partner.example.'],
  policy_invalid: ['The policy isn’t valid', 'The details name the field to fix.'],
  invalid_client_proof: ['The client proof isn’t valid', 'Check the value and try again.'],
  owner_nonce_mismatch: ['The on-chain state moved on', 'Reload the page and try again.'],
  passkeys_required: ['This organisation requires passkeys', 'The member has to add a passkey first.'],
  org_frozen: ['This organisation is frozen', 'Unfreeze it first if the change should go ahead.'],
  user_disabled: ['This user is disabled', 'Enable the user first if the change should go ahead.'],
  already_member: ['This person is already a member', 'Change their role in Members instead.'],
  invite_invalid: ['That invite can’t be used', 'It was revoked, accepted or has expired. Send a new invite.'],
  not_invited: ['This person has no invite', 'Send them an invite first.'],
  rate_limited: ['Too many requests', 'Wait a few minutes, then try again.'],
  near_unavailable: ['NEAR didn’t answer', 'Nothing was changed. Try again in a minute.'],
  method_not_allowed: ['The console sent a request the server doesn’t take', 'Reload the page: the console may be out of date.'],
  payload_too_large: ['That’s too large to send', 'Shorten it and try again.'],
  internal: ['Something went wrong on the server', 'Try again. If it keeps failing, pass the error code to whoever is on call.'],
  watchdog_unconfigured: ['The watchdog isn’t set up for this console', 'Its address and status token are missing from the admin Worker (docs/operations.md "Security & monitoring").'],
  watchdog_unavailable: ['The watchdog didn’t answer', 'Try again in a minute. The watchdog keeps alerting on its own.'],
  watchdog_timeout: ['The watchdog took too long to answer', 'Try again in a minute. The watchdog keeps alerting on its own.'],
  watchdog_too_large: ['The watchdog’s answer was too large', 'Tell an engineer: the admin Worker caps what it accepts.'],
  watchdog_bad_answer: ['The watchdog’s answer wasn’t understood', 'Tell an engineer: the watchdog and the admin Worker may be on different versions.'],
  watchdog_unauthorized: ['The watchdog refused this console', 'The two copies of the watchdog’s status token differ (docs/operations.md "Security & monitoring").'],
  already_acknowledged: ['Someone already acknowledged this alert', 'Reload the page to see who.'],
  directory_unavailable: ['The user directory isn’t available', 'The email issuer is missing in this environment or didn’t answer. Try again in a minute.'],
  directory_refused: ['The user directory refused your staff identity', 'Its admin Access settings differ from this console’s (docs/operations.md "Users screen").'],
};

/** An error as {title, detail, hint, code, status}: plain words first, the server's own text and the code underneath. */
function explain(err) {
  if (!(err instanceof ApiError)) return { title: 'Something went wrong in this page', detail: String(err && err.message ? err.message : err), hint: 'Reload the page and try again.' };
  const msg = err.message || '';
  const base = { detail: msg && msg !== err.code ? msg : '', code: err.code, status: err.status };
  if (/org_legacy has no members/u.test(msg)) return { ...base, title: 'Legacy apps has no members', hint: LEGACY_HINT };
  if (/org_legacy can['’]t be frozen/u.test(msg)) return { ...base, title: 'Legacy apps can’t be frozen', hint: 'To stop its apps, suspend them instead (the danger zone at the bottom of the page).' };
  if (/assigned to org_legacy/u.test(msg)) return { ...base, title: 'A scope can’t be moved into Legacy apps', hint: 'Choose the partner’s organisation instead.' };
  const known = ERRORS[err.code];
  if (known) return { ...base, title: known[0], hint: known[1] };
  return { ...base, title: err.status ? `The server refused the request (HTTP ${err.status})` : 'The request failed', hint: 'Read the details, then reload the page and try again.' };
}

function errorBox(err) {
  const e = explain(err);
  return h(
    'div',
    { class: 'alert error', role: 'alert' },
    h('strong', {}, e.title),
    e.detail ? h('p', { class: 'detail' }, e.detail) : '',
    e.hint ? h('p', {}, richText(e.hint)) : '',
    e.code ? h('p', { class: 'code' }, 'Error code ', h('code', {}, e.code), e.status ? ` (HTTP ${e.status})` : '') : '',
  );
}

/** A message box: kind is info, ok, warn or error; the first child is its title when it is a string. */
function note(kind, title, ...body) {
  return h('div', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : undefined }, title ? h('strong', {}, title) : '', ...body.map((b) => (typeof b === 'string' ? h('p', {}, richText(b)) : b)));
}

function emptyState(title, text) {
  return h('div', { class: 'empty-state' }, h('strong', {}, title), text ? richText(text) : '');
}

const loading = (text) => h('p', { class: 'loading', role: 'status' }, text || 'Loading…');

// ---- page structure ----

let uid = 0;
const nextId = (p) => `${p}-${(uid += 1)}`;

/** The page's header: a back link, the title, a subtitle, small facts, and at most one primary action. */
function pageHead(title, opts = {}) {
  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'titles' },
      opts.back ? h('a', { href: opts.back.href, 'data-link': true, class: 'back' }, `← ${opts.back.text}`) : '',
      h('h1', { tabindex: '-1' }, title),
      opts.subtitle ? h('p', { class: 'subtitle' }, richText(opts.subtitle)) : '',
      opts.meta && opts.meta.length ? h('div', { class: 'meta' }, opts.meta) : '',
    ),
    opts.actions && opts.actions.length ? h('div', { class: 'page-actions' }, opts.actions) : '',
  );
}

/** A section of a page: a titled panel with an optional hint and actions in its header. */
function panel(title, opts, ...children) {
  const id = nextId('panel');
  return h(
    'section',
    { class: `panel${opts && opts.danger ? ' danger-zone' : ''}`, 'aria-labelledby': id, id: opts && opts.anchor },
    h('div', { class: 'panel-head' }, h('h2', { id }, title), opts && opts.actions ? h('div', { class: 'row' }, opts.actions) : ''),
    opts && opts.hint ? h('p', { class: 'hint' }, richText(opts.hint)) : '',
    ...children,
  );
}

/** A button that shows or hides `content` below it (forms that are needed now and then, not on every visit). */
function disclosure(label, content, opts = {}) {
  const box = h('div', { hidden: !opts.open }, content);
  const btn = h(
    'button',
    {
      type: 'button',
      class: [opts.primary ? 'primary' : '', opts.small ? 'small' : ''].filter(Boolean).join(' ') || undefined,
      'aria-expanded': opts.open ? 'true' : 'false',
      onclick: () => {
        const open = box.hidden;
        box.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          const first = box.querySelector('input, select, textarea, button');
          if (first) first.focus();
          if (opts.onOpen) opts.onOpen(box);
        }
      },
    },
    label,
  );
  return { button: btn, box };
}

// ---- confirmations, in the page ----

/** The confirmation strip: what will happen, a button that does it and one that doesn't. Escape cancels. */
function confirmStrip(text, label, danger, onYes, onNo) {
  const yes = h('button', { type: 'button', class: danger ? 'danger solid small' : 'primary small', onclick: onYes }, label);
  const no = h('button', { type: 'button', class: 'small', onclick: onNo }, 'Cancel');
  const box = h(
    'div',
    {
      class: `confirm${danger ? ' danger' : ''}`,
      role: 'group',
      'aria-label': `Confirm: ${label}`,
      onkeydown: (ev) => {
        if (ev.key === 'Escape') onNo();
      },
    },
    h('p', {}, richText(text)),
    h('div', { class: 'form-actions' }, yes, no),
  );
  return { box, yes };
}

/** A message shown once at the top of the next page render (after an action re-renders it). */
let flash = null;

/** A button that runs `action()` (after an in-page confirmation when given) and re-renders the page. */
function actionButton(label, action, confirmText, danger, opts = {}) {
  const wrap = h('span', { class: 'inline-action' });
  const status = h('span');
  const btn = h('button', { type: 'button', class: [danger ? 'danger' : opts.primary ? 'primary' : '', opts.large ? '' : 'small'].filter(Boolean).join(' ') || undefined }, label);
  const run = async () => {
    status.replaceChildren();
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await action();
      if (opts.done) flash = opts.done;
      await render();
    } catch (err) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      status.replaceChildren(errorBox(err));
    }
  };
  btn.addEventListener('click', () => {
    if (!confirmText) return void run();
    if (wrap.querySelector('.confirm')) return undefined;
    const c = confirmStrip(
      confirmText,
      label,
      danger,
      () => {
        c.box.remove();
        btn.hidden = false;
        void run();
      },
      () => {
        c.box.remove();
        btn.hidden = false;
        btn.focus();
      },
    );
    btn.hidden = true;
    wrap.append(c.box);
    c.yes.focus();
    return undefined;
  });
  wrap.append(btn, status);
  return wrap;
}

/** A disabled button with the reason next to it: an action that can't work, said plainly. */
const unavailable = (label, why) => h('span', { class: 'inline-action' }, h('button', { type: 'button', class: 'small', disabled: true }, label), h('span', { class: 'hint' }, why));

/** One labelled input. A field: {name, label, type, options, placeholder, required, value, help, size, …}. */
function field(f) {
  let input;
  const common = { name: f.name, id: nextId(`f-${f.name}`), required: f.required, placeholder: f.placeholder || undefined, pattern: f.pattern, minlength: f.minlength, maxlength: f.maxlength, min: f.min, max: f.max, autocomplete: f.autocomplete || 'off' };
  if (f.type === 'select') input = h('select', { name: f.name, id: common.id }, f.options.map((o) => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value || undefined }, o.label ?? o)));
  else if (f.type === 'textarea') input = h('textarea', common, f.value ?? '');
  else if (f.type === 'checkbox') return h('label', { class: 'check' }, h('input', { name: f.name, type: 'checkbox', checked: !!f.value }), f.label);
  else input = h('input', { ...common, type: f.type || 'text', value: f.value ?? '' });
  const helpId = f.help ? `${common.id}-help` : undefined;
  if (helpId) input.setAttribute('aria-describedby', helpId);
  return h(
    'label',
    { class: `field${f.size ? ` ${f.size}` : ''}`, for: common.id },
    h('span', { class: 'label' }, f.label, f.required ? '' : f.optional === false ? '' : h('span', { class: 'req' }, f.optionalText || ' (optional)')),
    input,
    f.help ? h('span', { class: 'help', id: helpId }, richText(f.help)) : '',
  );
}

/** A form whose submit runs `action(values)` (after an in-page confirmation when `opts.confirm`), then re-renders. */
function form(fields, label, action, opts = {}) {
  const status = h('div');
  const submit = h('button', { type: 'submit', class: opts.danger ? 'danger' : 'primary' }, label);
  const actions = h('div', { class: 'form-actions' }, submit, opts.extra || '');
  const run = async (values) => {
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    try {
      const out = await action(values);
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      if (opts.after) opts.after(out, status);
      else {
        if (opts.done) flash = typeof opts.done === 'function' ? opts.done(values, out) : opts.done;
        await render();
      }
    } catch (err) {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      status.replaceChildren(errorBox(err));
    }
  };
  const el = h(
    'form',
    {
      class: `form${opts.vertical ? ' vertical' : ''}`,
      onsubmit: (ev) => {
        ev.preventDefault();
        status.replaceChildren();
        const values = {};
        for (const f of fields) {
          const input = el.elements[f.name];
          values[f.name] = input.type === 'checkbox' ? input.checked : input.value;
        }
        if (!opts.confirm) return void run(values);
        if (actions.querySelector('.confirm')) return undefined;
        const text = typeof opts.confirm === 'function' ? opts.confirm(values) : opts.confirm;
        const c = confirmStrip(
          text,
          opts.confirmLabel || label,
          opts.danger,
          () => {
            c.box.remove();
            submit.hidden = false;
            void run(values);
          },
          () => {
            c.box.remove();
            submit.hidden = false;
            submit.focus();
          },
        );
        submit.hidden = true;
        actions.append(c.box);
        c.yes.focus();
        return undefined;
      },
    },
    fields.map(field),
    actions,
  );
  return h('div', {}, el, status);
}

/** A table. A header is a string or {text, num}; an empty table says `opts.empty` (what is missing, or what to do). */
/** USD micros as `$9.99` (rounded up to the cent, as the vault shows it). */
const usdMicros = (n) => `$${(Math.ceil(n / 10_000) / 100).toFixed(2)}`;

/**
 * The user's key exports and mainnet demo signatures (D426, D428; StaffUser.events), newest first; nothing when the
 * answer carries no `events` (a list row, or an older API).
 */
function userEventsBlock(u) {
  if (!Array.isArray(u.events)) return [];
  return [
    h('h3', {}, 'Key exports and mainnet demo signatures'),
    table(
      ['When', 'What', 'App', 'Chain', 'Detail'],
      u.events.map((e) =>
        tr(
          time(e.at),
          e.kind === 'key_exported' ? h('span', { class: 'badge warning' }, 'Key exported') : h('span', { class: 'badge' }, 'Mainnet demo signature'),
          h('code', {}, e.appId),
          e.chain ? chainLabel(e.chain) : 'unknown (older export window)',
          e.kind === 'key_exported'
            ? 'The export window signed in again and derived the key; the user may have shown or copied it.'
            : h('span', {}, `${e.network === 'pubnet' ? 'Stellar public network' : `EVM chain ${e.network}`}, about ${usdMicros(e.usdMicros || 0)} from `, h('code', {}, e.address), h('span', { class: 'sub' }, ' as the vault reported it')),
        ),
      ),
      { empty: 'No key export and no mainnet demo signature.' },
    ),
  ];
}

function table(headers, rows, opts = {}) {
  const hs = headers.map((x) => (typeof x === 'string' ? { text: x } : x));
  const body = rows.filter(Boolean);
  return h(
    'div',
    { class: `table-wrap${opts.class ? ` ${opts.class}` : ''}` },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, hs.map((x) => h('th', { scope: 'col', class: [x.num ? 'num' : '', x.extra ? 'extra' : ''].filter(Boolean).join(' ') || undefined }, x.text)))),
      h('tbody', {}, body.length ? body : [h('tr', {}, h('td', { colspan: hs.length, class: 'empty' }, opts.empty || 'Nothing here yet.'))]),
    ),
  );
}

/** A row; a cell that is just a time (`time()`) doesn't wrap. */
const tr = (...cells) => h('tr', {}, cells.map((c) => h('td', {}, typeof c === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u.test(c) ? h('span', { class: 'nw' }, c) : c)));
/** A two-column table of facts: [label, value] rows. */
const facts = (rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'kv' }, h('tbody', {}, rows.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v))))));
const lines = (s) => s.split(/[\s,]+/u).map((x) => x.trim()).filter(Boolean);

/** A record's details as `key: value` pairs (nested values as compact JSON), never one long JSON line. */
function detailPairs(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  const entries = Object.entries(v);
  if (!entries.length) return '';
  return h('span', { class: 'kvs' }, entries.map(([k, x]) => h('span', {}, h('b', {}, `${k}: `), typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))));
}

/** An integer decimal string of 10^-decimals units, exactly (string arithmetic, never a float); '' when absent. */
function units(v, decimals) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  if (!/^\d+$/u.test(s)) return s;
  const padded = s.padStart(decimals + 1, '0');
  const int = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/u, '');
  const frac = padded.slice(padded.length - decimals).replace(/0+$/u, '');
  return frac ? `${int}.${frac}` : int;
}
const near = (yocto) => units(yocto, 24);
const usd = (micros) => (micros === undefined || micros === null ? '—' : units(micros, 6));
const enc = encodeURIComponent;
const thisMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/** A filter form that writes its fields into the page's query string (GET), then re-renders. */
function queryForm(path, fields, label) {
  const params = new URLSearchParams(location.search);
  const el = h(
    'form',
    {
      class: 'form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        for (const f of fields) {
          const v = String(el.elements[f.name].value || '').trim();
          if (v) q.set(f.name, v);
        }
        history.pushState(null, '', `${path}?${q}`);
        render();
      },
    },
    fields.map((f) => field({ ...f, value: params.get(f.name) ?? f.value ?? '', optional: f.optional ?? false })),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, label)),
  );
  return el;
}

/** The organisations as select options, by name (the first page); `exclude` leaves some out. */
async function orgOptions(exclude = []) {
  const d = await api('GET', '/api/orgs');
  return d.orgs
    .filter((o) => !exclude.includes(o.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => ({ value: o.id, label: `${o.id === LEGACY_ORG ? 'Legacy apps' : o.name} (${o.id})` }));
}

// ---- labels for the system's words ----

const badge = (text, kind) => h('span', { class: `badge ${kind || ''}` }, text);
const ORG_KIND = { partner: 'Partner', internal: 'Internal' };
const orgKind = (o) => (o.id === LEGACY_ORG ? 'Legacy' : ORG_KIND[o.kind] || o.kind);
const orgStatus = (s) => (s === 'frozen' ? badge('Frozen', 'bad') : badge('Active', 'ok'));
const envBadge = (e) => (e === 'live' ? badge('Live', 'info') : badge(e === 'test' ? 'Test' : e || 'unknown'));
/** Who suspended an app: the three switches of `suspendedBy`. */
const SUSPENDERS = [
  [1, 'Hana'],
  [2, 'the organisation-wide switch'],
  [4, 'the partner'],
];
const suspendedBy = (bits) => SUSPENDERS.filter(([b]) => bits & b).map(([, who]) => who);
function appState(a) {
  if (a.deleted) return badge('Deleted');
  if (a.suspendedBy) return h('span', {}, badge('Suspended', 'bad'), h('span', { class: 'sub' }, `by ${suspendedBy(a.suspendedBy).join(', ')}`));
  return badge('Active', 'ok');
}
const ACTOR = { hana: 'Hana staff', member: 'Member', system: 'System', link: 'Account link' };
const actor = (kind, id) => h('span', {}, ACTOR[kind] || kind, id ? h('span', { class: 'sub' }, id) : '');
const CHANGE_KIND = { origin_add: 'Add an origin', policy_set: 'Set an auto-approve policy', raw_sign_on: 'Turn raw signing on' };
const CHANGE_STATUS = { pending: ['Pending', 'warning'], active: ['In force', 'ok'], cancelled: ['Cancelled', ''], ended: ['Ended', ''] };
const changeStatus = (s) => badge(...(CHANGE_STATUS[s] || [s, '']));
/** The app-change log's kinds (`app_changes.kind`), in words. */
const LOG_KIND = {
  'app.created': 'App created',
  'app.deleted': 'App deleted',
  'app.suspended': 'App suspended',
  'app.resumed': 'Suspension lifted',
  'change.proposed': 'Change proposed',
  'change.announced': 'Change emailed',
  'change.cancelled': 'Change cancelled',
  'change.expedited': 'Change put in force early',
  'key.created': 'Key created',
  'key.revoked': 'Key revoked',
  'key.rotated': 'Key rotated',
  'origin.proposed': 'Origin proposed',
  'origin.removed': 'Origin removed',
  'org.security_contacts': 'Security contacts replaced',
  'scope.assigned': 'Scope moved here',
};
const logKind = (k) => h('span', {}, LOG_KIND[k] || k, LOG_KIND[k] ? h('span', { class: 'sub' }, h('code', {}, k)) : '');

// ---- navigation ----

// The screens, grouped by the task staff come for; System status (D425) first, the landing page. Reports, statements and rates are C12's; Security & monitoring, the
// pending-upgrades page and the playbooks are C14's; retention is C13's; Users is C8b's (D275); the Support ID lookup is
// C15's (D394–D396, D399).
const NAV_GROUPS = [
  { title: 'Overview', items: [{ path: '/status', label: 'Status' }] },
  { title: 'Partners', items: [{ path: '/orgs', label: 'Organisations' }] },
  { title: 'Support', items: [{ path: '/users', label: 'Users' }, { path: '/support', label: 'Support ID lookup' }] },
  {
    title: 'Security',
    items: [
      { path: '/security/monitoring', label: 'Security & monitoring' },
      { path: '/security', label: 'Feed and notices' },
      { path: '/security/upgrades', label: 'Pending upgrades' },
      { path: '/security/playbooks', label: 'Playbooks' },
      { path: '/audit', label: 'Audit log' },
    ],
  },
  { title: 'Money', items: [{ path: '/reports', label: 'Reports' }, { path: '/statements', label: 'Statements' }, { path: '/rates', label: 'Rates' }] },
  { title: 'System', items: [{ path: '/retention', label: 'Retention' }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

function renderNav() {
  const nav = document.getElementById('nav');
  // The longest nav path the current path is under is the active one (/security/playbooks/x → Playbooks).
  const under = (p) => location.pathname === p || location.pathname.startsWith(`${p}/`) || (p === '/status' && location.pathname === '/');
  const active = NAV.filter((n) => under(n.path)).sort((a, b) => b.path.length - a.path.length)[0];
  nav.replaceChildren(
    ...NAV_GROUPS.map((g) => {
      const id = `nav-${g.title.toLowerCase()}`;
      return h('div', { class: 'nav-group', role: 'group', 'aria-labelledby': id }, h('h2', { id }, g.title), g.items.map((n) => h('a', { href: n.path, 'data-link': true, class: n === active ? 'active' : undefined, 'aria-current': n === active ? 'page' : undefined }, n.label)));
    }),
  );
}

/** Set by a navigation: the next render moves focus to the page's heading (keyboard and screen-reader users). */
let focusHeading = false;

document.addEventListener('click', (ev) => {
  const a = ev.target.closest && ev.target.closest('a[data-link]');
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  ev.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  focusHeading = true;
  render();
});
window.addEventListener('popstate', () => {
  focusHeading = true;
  render();
});

// ---- organisations ----

/** Set by "Invite a new partner" on the Legacy apps page: the organisations page opens with its invite form open. */
let openInvite = false;

function newPartnerForm() {
  return form(
    [
      { name: 'newOrgName', label: 'Organisation name', placeholder: 'Lumen Pay', required: true, help: 'As the partner wants it shown in their console.' },
      { name: 'email', type: 'email', label: 'First owner’s email', placeholder: 'owner@partner.example', required: true, autocomplete: 'off', help: 'They get a link by email. It works once that email has gone out (within 5 minutes).' },
      {
        name: 'kind',
        type: 'select',
        label: 'Type',
        optional: false,
        options: [
          { value: 'partner', label: 'Partner' },
          { value: 'internal', label: 'Internal (Hana’s own apps)' },
        ],
      },
    ],
    'Send invite',
    (v) => api('POST', '/api/invites', { email: v.email, role: 'owner', newOrgName: v.newOrgName, kind: v.kind }),
    { done: (v) => `Invite sent to ${v.email.trim()} for the new organisation “${v.newOrgName.trim()}”. The email goes out within 5 minutes; the organisation is listed here once they accept.` },
  );
}

async function orgsPage(main) {
  const cursor = new URLSearchParams(location.search).get('cursor');
  const data = await api('GET', `/api/orgs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  const invite = disclosure('Invite a new partner', panel('Invite a new partner', { hint: 'Creates the organisation when its first owner accepts. Then create their apps, or move their existing scope from Legacy apps.' }, newPartnerForm()), { primary: true, open: openInvite });
  openInvite = false;
  // Legacy apps last: it is a holding place, not a partner.
  const list = [...data.orgs].sort((a, b) => (a.id === LEGACY_ORG) - (b.id === LEGACY_ORG));
  main.append(
    pageHead('Organisations', { subtitle: 'Partners and their apps. Start here to onboard a partner, change an app or freeze an organisation.', actions: [invite.button] }),
    invite.box,
    panel(
      `${data.orgs.length} organisation${data.orgs.length === 1 ? '' : 's'}`,
      {},
      table(
        ['Organisation', 'Type', 'Status', 'Created'],
        list.map((o) =>
          tr(
            o.id === LEGACY_ORG ? h('span', {}, link(`/orgs/${encodeURIComponent(o.id)}`, 'Legacy apps'), h('span', { class: 'sub' }, 'Scopes from before organisations, waiting to be moved to their partner')) : h('span', {}, link(`/orgs/${encodeURIComponent(o.id)}`, o.name), h('span', { class: 'sub' }, h('code', {}, o.id))),
            orgKind(o),
            orgStatus(o.status),
            when(o.createdAt),
          ),
        ),
        { empty: 'No organisation yet. Use “Invite a new partner” to create the first one.' },
      ),
      data.next ? h('p', {}, link(`/orgs?cursor=${encodeURIComponent(data.next)}`, 'Next page')) : '',
    ),
  );
}

function membersPanel(o, d) {
  const owners = d.members.filter((m) => m.role === 'owner' && !m.disabled);
  const inviteForm = form(
    [
      { name: 'email', type: 'email', label: 'Email', placeholder: 'person@partner.example', required: true },
      {
        name: 'role',
        type: 'select',
        label: 'Role',
        optional: false,
        options: [
          { value: 'viewer', label: 'Viewer (read only)' },
          { value: 'owner', label: 'Owner' },
        ],
        help: 'A new owner waits for the owner-grant period first; every owner and security contact is told.',
      },
    ],
    'Send invite',
    (v) => api('POST', '/api/invites', { email: v.email, role: v.role, orgId: o.id }),
    { done: (v) => `Invite sent to ${v.email.trim()}. The email goes out within 5 minutes; the link works from then.` },
  );
  return panel(
    'Members',
    { anchor: 'members', hint: owners.length ? '' : 'No active owner: invite one, so the organisation can manage its apps.' },
    table(
      ['Person', 'Role', 'Since', 'Status', ''],
      d.members.map((m) =>
        tr(
          named(m.email, m.userId),
          m.pendingOwnerFrom ? h('span', {}, 'Viewer', h('span', { class: 'sub' }, `owner from ${time(m.pendingOwnerFrom)}`)) : m.role === 'owner' ? 'Owner' : 'Viewer',
          when(m.roleSince),
          m.disabled ? badge('Disabled', 'bad') : badge('Active', 'ok'),
          h(
            'div',
            { class: 'cell-actions' },
            actionButton(m.role === 'owner' ? 'Make viewer' : 'Make owner', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/members/${encodeURIComponent(m.userId)}`, { role: m.role === 'owner' ? 'viewer' : 'owner' }), m.role === 'owner' ? `Make ${m.email} a viewer? They keep read access only.` : `Make ${m.email} an owner? They wait for the owner-grant period first, and every owner and security contact is emailed.`, false, { done: `Role changed for ${m.email}.` }),
            actionButton('Remove', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/members/${encodeURIComponent(m.userId)}`, { role: null }), `Remove ${m.email} from ${o.name}? They lose access to it at once.`, true, { done: `${m.email} was removed.` }),
            actionButton(m.disabled ? 'Enable user' : 'Disable user', () => api('POST', `/api/users/${encodeURIComponent(m.userId)}/disable`, { disabled: !m.disabled }), m.disabled ? null : `Disable ${m.email} everywhere, in every organisation? Their sessions end at once.`, !m.disabled, { done: m.disabled ? `${m.email} can sign in again.` : `${m.email} is disabled.` }),
          ),
        ),
      ),
      { empty: 'No member yet. Invite the first owner below.' },
    ),
    h('h3', {}, 'Invite someone'),
    inviteForm,
  );
}

function invitesPanel(d) {
  if (!d.invites.length) return '';
  const now = Date.now();
  const state = (i) => (i.acceptedAt ? badge('Accepted', 'ok') : i.revokedAt ? badge('Revoked') : i.expiresAt < now ? badge('Expired') : i.notifiedAt ? badge('Open', 'info') : badge('Email not sent yet', 'warning'));
  return panel(
    'Invites',
    { hint: 'An invite works only once its email has gone out (the job runs every 5 minutes).' },
    table(
      ['Email', 'Role', 'Sent', 'Expires', 'State', ''],
      d.invites.map((i) =>
        tr(
          named(i.email, i.id),
          i.role === 'owner' ? 'Owner' : 'Viewer',
          i.notifiedAt ? when(i.notifiedAt) : h('span', { class: 'muted' }, 'not yet'),
          when(i.expiresAt),
          state(i),
          !i.acceptedAt && !i.revokedAt ? actionButton('Revoke', () => api('POST', `/api/invites/${encodeURIComponent(i.id)}/revoke`), `Revoke the invite for ${i.email}? Its link stops working.`, true, { done: `The invite for ${i.email} was revoked.` }) : '',
        ),
      ),
    ),
  );
}

function grantsPanel(d) {
  if (!d.grants.length) return '';
  const byId = new Map(d.members.map((m) => [m.userId, m.email]));
  const invites = new Map(d.invites.map((i) => [i.id, i.email]));
  return panel(
    'Pending owner grants',
    { hint: 'A new owner waits this period so the other owners can react. Cancelling keeps the person as a viewer.' },
    table(
      ['Person', 'Granted by', 'Emailed', 'Owner from', ''],
      d.grants.map((g) =>
        tr(
          named(byId.get(g.userId) || invites.get(g.inviteId) || 'Unknown person', g.userId || g.inviteId || ''),
          actor(g.grantedByKind, g.grantedBy),
          g.notifiedAt ? when(g.notifiedAt) : h('span', { class: 'muted' }, 'not yet'),
          g.ownerFrom ? when(g.ownerFrom) : h('span', { class: 'muted' }, 'when the invite is accepted'),
          actionButton('Cancel grant', () => api('POST', `/api/owner-grants/${encodeURIComponent(g.id)}/cancel`), 'Cancel this owner grant? The person stays a viewer.', true, { done: 'The owner grant was cancelled.' }),
        ),
      ),
    ),
  );
}

function appsTable(o, apps) {
  return table(
    ['App', 'Environment', 'Scope', 'State', { text: 'Origins', num: true }, { text: 'Pending changes', num: true }],
    apps.map((a) => tr(h('span', {}, link(`/orgs/${encodeURIComponent(o.id)}/apps/${encodeURIComponent(a.id)}`, a.name), h('span', { class: 'sub' }, h('code', {}, a.id))), envBadge(a.environment), mono(a.scopeId), appState(a), String(a.activeOrigins), a.pendingChanges ? h('strong', {}, String(a.pendingChanges)) : '0')),
    { empty: 'No app yet.' },
  );
}

/** The legacy scopes as select options (read when staff open "Move a legacy scope here"). */
async function legacyScopeOptions() {
  const d = await api('GET', `/api/orgs/${LEGACY_ORG}`);
  const scopes = new Map();
  for (const a of d.apps) {
    if (!scopes.has(a.scopeId)) scopes.set(a.scopeId, []);
    if (!a.deleted) scopes.get(a.scopeId).push(`${a.name} (${a.environment})`);
  }
  return [...scopes].map(([scopeId, names]) => ({ value: scopeId, label: `${scopeId}: ${names.join(', ') || 'deleted apps only'}` }));
}

function appsPanel(o, d) {
  // createApp refuses an organisation without a security contact; moving a legacy scope here doesn't need one.
  const blocked = d.flags.noSecurityContacts ? 'Add a security contact before creating an app: an organisation without one can’t get new apps.' : '';
  const create = disclosure(
    'Create an app',
    h(
      'div',
      {},
      h('h3', {}, 'Create an app'),
      form(
        [
          { name: 'scopeId', label: 'Scope id', placeholder: 's…', required: true, help: 'The scope must be registered on chain. If it has Google-account owners on chain, each must be an owner of this organisation, or the app is refused (scope_conflict).' },
          { name: 'environment', type: 'select', label: 'Environment', optional: false, options: [{ value: 'test', label: 'Test' }, { value: 'live', label: 'Live' }] },
          { name: 'name', label: 'App name', placeholder: 'Lumen Pay checkout', required: true },
          { name: 'origins', label: 'Allowed origins', placeholder: 'https://app.partner.example', size: 'wide', help: 'Space or comma separated. The security contacts are emailed and they take effect after the waiting period.' },
        ],
        'Create app',
        (v) => api('POST', '/api/apps', { orgId: o.id, scopeId: v.scopeId, environment: v.environment, name: v.name, origins: lines(v.origins) }),
        { after: (out, status) => status.replaceChildren(note('ok', `Created ${out.app.id}`, h('p', {}, 'Its publishable key (give it to the partner; it is also listed on the app’s page): ', h('code', {}, out.publishableKey)), h('p', {}, link(`/orgs/${encodeURIComponent(o.id)}/apps/${encodeURIComponent(out.app.id)}`, 'Open the app')))) },
      ),
    ),
  );
  const move = disclosure(
    'Move a legacy scope here',
    h('div', {}, h('h3', {}, 'Move a legacy scope here'), loading('Reading Legacy apps…')),
    {
      onOpen: async (box) => {
        if (box.dataset.loaded) return;
        box.dataset.loaded = '1';
        try {
          const options = await legacyScopeOptions();
          box.replaceChildren(
            h('h3', {}, 'Move a legacy scope here'),
            options.length
              ? form([{ name: 'scopeId', type: 'select', label: 'Legacy scope', optional: false, options, size: 'wide', help: 'Every app of the scope moves.' }], 'Move scope', (v) => api('POST', `/api/scopes/${encodeURIComponent(v.scopeId)}/assign`, { orgId: o.id }), { confirm: (v) => `Move scope ${v.scopeId} and every app in it into ${o.name}? If the scope has Google-account owners on chain, each must be an owner of that organisation first, or the move is refused (scope_conflict). This can’t be undone from the console.`, done: (v) => `Scope ${v.scopeId} now belongs to ${o.name}.` })
              : emptyState('Legacy apps is empty', 'Every legacy scope already belongs to an organisation.'),
          );
        } catch (err) {
          box.dataset.loaded = '';
          box.replaceChildren(errorBox(err));
        }
      },
    },
  );
  return panel(
    'Apps',
    { actions: blocked ? [move.button] : [create.button, move.button] },
    blocked ? note('warn', '', blocked) : '',
    appsTable(o, d.apps),
    blocked ? '' : create.box,
    move.box,
  );
}

function contactsPanel(o, d) {
  return panel(
    'Security contacts',
    { anchor: 'contacts', hint: 'They are emailed about every app change and security event of this organisation.' },
    d.securityContacts.length ? h('p', {}, d.securityContacts.join(', ')) : emptyState('No security contact yet', 'Add at least one: the organisation can’t get apps until it has one.'),
    form(
      [{ name: 'emails', label: 'Replace with', placeholder: 'a@partner.example, b@partner.example', value: d.securityContacts.join(', '), required: true, size: 'wide', help: 'Comma or space separated. The old and the new contacts are emailed.' }],
      'Replace contacts',
      (v) => api('PUT', `/api/orgs/${encodeURIComponent(o.id)}/security-contacts`, { emails: lines(v.emails) }),
      { confirm: (v) => `Replace the security contacts with ${lines(v.emails).join(', ')}? The old and the new contacts are emailed.`, done: 'Security contacts replaced.' },
    ),
  );
}

function dangerPanel(o, legacy) {
  const id = encodeURIComponent(o.id);
  return panel(
    'Danger zone',
    { danger: true },
    h(
      'div',
      { class: 'stack' },
      legacy
        ? ''
        : h(
            'div',
            {},
            h('h3', {}, o.status === 'frozen' ? 'Unfreeze' : 'Freeze the organisation'),
            h('p', { class: 'hint' }, 'Frozen: its members are signed out, and every console write except cancels and kill switches is refused. Apps keep working.'),
            actionButton(o.status === 'frozen' ? 'Unfreeze' : 'Freeze', () => api('POST', `/api/orgs/${id}/freeze`, { frozen: o.status !== 'frozen' }), o.status === 'frozen' ? null : `Freeze ${o.name}? Its members are signed out and every console write but cancels and kill switches is refused.`, o.status !== 'frozen', { done: o.status === 'frozen' ? `${o.name} is unfrozen.` : `${o.name} is frozen.` }),
          ),
      h(
        'div',
        {},
        h('h3', {}, 'Suspend every app'),
        h('p', { class: 'hint' }, 'The organisation-wide switch: logins to every app stop at once. Lifting it doesn’t lift a suspension set by Hana on one app or by the partner.'),
        h(
          'div',
          { class: 'row' },
          actionButton('Suspend every app', () => api('POST', `/api/orgs/${id}/suspend`, { suspended: true }), `Suspend every app of ${legacy ? 'Legacy apps' : o.name}? Logins stop at once.`, true, { done: 'Every app is suspended.' }),
          actionButton('Lift the organisation-wide suspension', () => api('POST', `/api/orgs/${id}/suspend`, { suspended: false }), null, false, { done: 'The organisation-wide suspension is lifted.' }),
        ),
      ),
    ),
  );
}

async function changesPanel(main, orgId) {
  const box = h('div', {}, loading());
  main.append(panel('Recent app changes', { hint: 'Every change to this organisation’s apps, newest first.' }, box));
  try {
    const changes = await api('GET', `/api/orgs/${encodeURIComponent(orgId)}/changes`);
    box.replaceChildren(changesTable(changes.changes));
  } catch (err) {
    box.replaceChildren(errorBox(err));
  }
}

/** Legacy apps (org_legacy): no members, no invites, no freeze; its scopes wait to be moved to their partner. */
async function legacyPage(main, d) {
  const o = d.org;
  const scopes = new Map();
  for (const a of d.apps) {
    if (!scopes.has(a.scopeId)) scopes.set(a.scopeId, []);
    scopes.get(a.scopeId).push(a);
  }
  let targets = null;
  const moveCell = (scopeId, apps) => {
    const live = apps.filter((a) => !a.deleted);
    const box = h('div', { hidden: true });
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'small',
        'aria-expanded': 'false',
        onclick: async () => {
          const open = box.hidden;
          box.hidden = !open;
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (!open || box.dataset.loaded) return;
          box.dataset.loaded = '1';
          box.replaceChildren(loading('Reading organisations…'));
          try {
            targets = targets || (await orgOptions([LEGACY_ORG]));
            box.replaceChildren(
              targets.length
                ? form(
                    [{ name: 'orgId', type: 'select', label: 'Move to', optional: false, options: targets, help: 'Every app of the scope moves.' }],
                    'Move scope',
                    (v) => api('POST', `/api/scopes/${encodeURIComponent(scopeId)}/assign`, { orgId: v.orgId }),
                    {
                      confirm: (v) => `Move scope ${scopeId} (${live.length} app${live.length === 1 ? '' : 's'}) to ${(targets.find((t) => t.value === v.orgId) || { label: v.orgId }).label}? If the scope has Google-account owners on chain, each must be an owner of that organisation first, or the move is refused (scope_conflict). This can’t be undone from the console.`,
                      done: (v) => `Scope ${scopeId} now belongs to ${(targets.find((t) => t.value === v.orgId) || { label: v.orgId }).label}. Its apps are on that organisation’s page.`,
                    },
                  )
                : emptyState('No organisation to move it to', 'Invite the partner’s first owner to a new organisation first.'),
            );
            const first = box.querySelector('select');
            if (first) first.focus();
          } catch (err) {
            box.dataset.loaded = '';
            box.replaceChildren(errorBox(err));
          }
        },
      },
      'Move to an organisation',
    );
    return h('div', { class: 'inline-action' }, btn, box);
  };
  main.append(
    pageHead('Legacy apps', {
      back: { href: '/orgs', text: 'Organisations' },
      subtitle: 'The scopes from before organisations existed. Each waits to be moved to its partner’s organisation.',
      meta: [orgStatus(o.status), badge('No members'), mono(o.id)],
      actions: [h('button', { type: 'button', class: 'primary', onclick: () => ((openInvite = true), (focusHeading = true), go('/orgs')) }, 'Invite a new partner')],
    }),
    note('info', 'Nobody can be invited to Legacy apps, and it can’t be frozen', 'To onboard a partner whose app is here: invite their first owner to a new organisation, then use “Move to an organisation” on the scope. If the scope has Google-account owners on chain, each must be an owner of that organisation first, or the move is refused (scope_conflict).'),
    panel(
      'Scopes waiting for an organisation',
      { hint: 'Moving a scope moves every app in it.' },
      table(
        ['Scope', 'Apps', ''],
        [...scopes].map(([scopeId, apps]) =>
          tr(
            mono(scopeId),
            h('div', {}, apps.map((a) => h('div', {}, link(`/orgs/${LEGACY_ORG}/apps/${encodeURIComponent(a.id)}`, a.name), ' ', envBadge(a.environment), a.deleted ? [' ', badge('Deleted')] : a.suspendedBy ? [' ', badge('Suspended', 'bad')] : ''))),
            moveCell(scopeId, apps),
          ),
        ),
        { empty: 'Every legacy scope already belongs to an organisation.' },
      ),
    ),
    contactsPanel({ ...o, name: 'Legacy apps' }, d),
  );
  await changesPanel(main, o.id);
  main.append(dangerPanel(o, true));
}

async function orgPage(main, orgId) {
  const d = await api('GET', `/api/orgs/${encodeURIComponent(orgId)}`);
  const o = d.org;
  if (o.id === LEGACY_ORG) return legacyPage(main, d);
  main.append(
    pageHead(o.name, {
      back: { href: '/orgs', text: 'Organisations' },
      meta: [orgStatus(o.status), ORG_KIND[o.kind] || o.kind, mono(o.id), `created ${time(o.createdAt)}`],
      actions: [h('button', { type: 'button', class: 'primary', onclick: () => main.querySelector('#members input[name=email]').focus() }, 'Invite someone')],
    }),
  );
  if (o.status === 'frozen') main.append(note('error', 'This organisation is frozen', 'Its members are signed out and console writes are refused, except cancels and kill switches. Unfreeze it in the danger zone at the bottom of the page.'));
  if (d.flags.noSecurityContacts) main.append(note('warn', 'No security contact', 'This organisation can’t get apps until it has one, and its notices go to the Hana security alias only. Add one under Security contacts.'));
  if (d.flags.ownersNotContacts.length) main.append(note('warn', 'Owners who aren’t security contacts', `${d.flags.ownersNotContacts.join(', ')}: add them under Security contacts so they hear about changes to their apps.`));
  main.append(membersPanel(o, d), invitesPanel(d), grantsPanel(d), appsPanel(o, d), contactsPanel(o, d));
  await changesPanel(main, o.id);
  main.append(dangerPanel(o, false));
  return undefined;
}

function changesTable(changes) {
  return table(
    ['When', 'What', 'App', 'By', 'Details'],
    changes.map((c) => tr(h('span', {}, time(c.at), h('span', { class: 'sub' }, `#${c.seq}`)), logKind(c.kind), mono(c.appId || ''), actor(c.actorKind, c.actorId), detailPairs(c.detail))),
    { empty: 'No app change yet.' },
  );
}

// ---- one app ----

async function appPage(main, orgId, appId) {
  const { app } = await api('GET', `/api/apps/${encodeURIComponent(appId)}?org=${encodeURIComponent(orgId)}`);
  const base = `/api/apps/${encodeURIComponent(app.id)}`;
  const legacy = orgId === LEGACY_ORG;
  main.append(
    pageHead(app.name, {
      back: { href: `/orgs/${encodeURIComponent(orgId)}`, text: legacy ? 'Legacy apps' : 'Organisation' },
      meta: [envBadge(app.environment), appState(app), mono(app.id), h('span', {}, 'scope ', mono(app.scopeId))],
    }),
  );
  if (app.deleted) main.append(note('warn', 'This app is deleted', 'Its keys are revoked. Nothing here can be changed.'));

  // Suspensions: one switch each for Hana, the organisation and the partner.
  const bits = [1, 2, 4].filter((b) => app.suspendedBy & b);
  main.append(
    panel(
      'Suspension',
      { hint: 'An app is suspended while any of its three switches is on: Hana’s, the organisation-wide one, or the partner’s own. Logins stop at once.' },
      bits.length
        ? table(
            ['Suspended by', ''],
            bits.map((b) => tr(SUSPENDERS.find(([x]) => x === b)[1].replace(/^the /u, '').replace(/^./u, (c) => c.toUpperCase()), actionButton(b === 4 ? 'Lift the partner’s suspension' : b === 2 ? 'Lift the organisation-wide suspension' : 'Lift Hana’s suspension', () => api('POST', `${base}/resume`, { bit: b }), b === 4 ? 'Lift the partner’s own suspension? Only do this when the partner asked for it.' : null, false, { done: 'Suspension lifted.' }))),
          )
        : h('p', {}, badge('Not suspended', 'ok'), ' Logins work.'),
    ),
  );

  main.append(
    panel(
      'Allowed origins',
      { hint: 'The web pages that may use this app. A new origin is emailed to the security contacts and takes effect after the waiting period; removing one takes effect at once.' },
      table(
        ['Origin', 'Shown to users as', 'State', ''],
        app.origins.map((x) =>
          tr(
            mono(x.origin),
            h('span', {}, x.display, x.idn ? [' ', badge('Lookalike check: international characters', 'warning')] : ''),
            x.activeFrom === null ? badge('Pending', 'warning') : h('span', {}, 'Active', h('span', { class: 'sub' }, `since ${time(x.activeFrom)}`)),
            app.deleted ? '' : actionButton('Remove', () => api('POST', `${base}/origins/remove`, { orgId, remove: [x.origin], expectedVersion: app.originsVersion }), `Remove ${x.origin}? It stops working at once.`, true, { done: `${x.origin} was removed.` }),
          ),
        ),
        { empty: 'No origin yet: the app can’t be used from any page until one is added.' },
      ),
      app.deleted
        ? ''
        : h(
            'div',
            {},
            h('h3', {}, 'Propose origins'),
            form(
              [{ name: 'add', label: 'Origins to add', placeholder: 'https://new.partner.example', required: true, size: 'wide', help: 'Full https:// origins, space or comma separated.' }],
              'Propose',
              (v) => api('POST', `${base}/origins`, { orgId, add: lines(v.add), expectedVersion: app.originsVersion }),
              { confirm: 'Propose these origins? The security contacts are emailed and they take effect after the delay.', done: 'Origins proposed. They take effect after the waiting period, once the email has gone out.' },
            ),
          ),
    ),
  );

  main.append(
    panel(
      'Guarded changes',
      { hint: 'Changes that wait a period after their email so the security contacts can react. Cancel one that nobody asked for.' },
      table(
        ['Change', 'State', 'Proposed', 'Emailed', 'In force from', ''],
        app.changes.map((c) =>
          tr(
            h('span', {}, CHANGE_KIND[c.kind] || c.kind, c.origin || c.policyId ? h('span', { class: 'sub' }, c.origin || c.policyId) : '', h('span', { class: 'sub' }, h('code', {}, c.id))),
            changeStatus(c.status),
            h('span', {}, time(c.proposedAt), h('span', { class: 'sub' }, `by ${ACTOR[c.proposedByKind] || c.proposedByKind} ${c.proposedBy}`)),
            c.notifiedAt ? when(c.notifiedAt) : h('span', { class: 'muted' }, 'not yet'),
            c.activeFrom ? when(c.activeFrom) : '',
            c.status === 'pending'
              ? h(
                  'div',
                  { class: 'cell-actions' },
                  actionButton('Cancel change', () => api('POST', `/api/changes/${encodeURIComponent(c.id)}/cancel`, { orgId }), 'Cancel this change? It won’t take effect.', true, { done: 'Change cancelled.' }),
                  c.proposedByKind === 'member' && c.notifiedAt ? expediteControl(c) : '',
                )
              : '',
          ),
        ),
        { empty: 'No guarded change.' },
      ),
    ),
  );

  const policy = app.settings && app.settings.policy;
  const proposePolicy = disclosure(
    'Propose an auto-approve policy',
    h(
      'div',
      {},
      h('h3', {}, 'Propose an auto-approve policy'),
      form(
        [{ name: 'policy', type: 'textarea', label: 'Policy (JSON)', placeholder: '{"v": 1, "label": "…", "maxConsentMs": …, "limits": {"perDayCount": …}, "stellar": {…}}', required: true, size: 'wide', help: 'The format is in docs/api.md. Each user consents to it before it signs anything for them.' }],
        'Propose policy',
        (v) => {
          let p;
          try {
            p = JSON.parse(v.policy);
          } catch {
            throw new Error('The policy is not valid JSON');
          }
          return api('POST', `${base}/changes`, { orgId, kind: 'policy_set', policy: p, expectedVersion: app.settingsVersion });
        },
        { confirm: 'Propose this policy? The contacts are emailed; it takes effect after the delay and each user consents to it.', done: 'Policy proposed. It takes effect after the waiting period.' },
      ),
    ),
    { small: true },
  );
  main.append(
    panel(
      'Signing settings',
      {},
      facts([
        ['Raw signing', app.settings.rawSign === 'off' ? 'Off' : `On (${app.settings.rawSign})`],
        // D426: only in an env where it can be set (a dev env on testnet): the API leaves it out elsewhere.
        ...(app.settings.mainnetDemo === undefined
          ? []
          : [['Mainnet demo', app.settings.mainnetDemo ? 'On: signs on Base and Stellar’s public network, up to $9.99 per transaction, every request through the approval popup' : 'Off: mainnets refused (D39)']]),
        ['Auto-approve policy', policy ? h('span', {}, policy.label || 'Unnamed policy', h('details', { class: 'raw' }, h('summary', {}, 'Show the policy'), h('pre', {}, JSON.stringify(policy, null, 2)))) : 'None'],
        ['Other settings', h('details', { class: 'raw' }, h('summary', {}, 'Show all settings'), h('pre', {}, JSON.stringify(app.settings, null, 2)))],
      ]),
      app.deleted
        ? ''
        : h(
            'div',
            { class: 'row' },
            policy ? actionButton('Remove the policy', () => api('POST', `${base}/off`, { orgId, what: 'policy', expectedVersion: app.settingsVersion }), 'Remove the auto-approve policy? Auto-signing stops within 10 s.', true, { done: 'Policy removed.' }) : '',
            app.settings.rawSign !== 'off' ? actionButton('Turn raw signing off', () => api('POST', `${base}/off`, { orgId, what: 'raw_sign', expectedVersion: app.settingsVersion }), 'Turn raw signing off? It stops at once.', true, { done: 'Raw signing is off.' }) : '',
            app.environment === 'live' && app.settings.rawSign === 'off' ? actionButton('Propose raw signing on', () => api('POST', `${base}/changes`, { orgId, kind: 'raw_sign_on', expectedVersion: app.settingsVersion }), 'Propose raw signing (with approval)? The contacts are emailed; it takes effect after the delay.', false, { done: 'Raw signing proposed. It takes effect after the waiting period.' }) : '',
            app.settings.mainnetDemo !== undefined && app.environment === 'test'
              ? actionButton(
                  app.settings.mainnetDemo ? 'Turn the mainnet demo off' : 'Turn the mainnet demo on',
                  () => api('POST', `${base}/mainnet-demo`, { orgId, on: !app.settings.mainnetDemo, expectedVersion: app.settingsVersion }),
                  app.settings.mainnetDemo
                    ? 'Turn the mainnet demo off? Open wallets stop signing on mainnets within 10 s.'
                    : 'Turn the mainnet demo on? This test app’s users can then sign real-funds transactions on Base and Stellar (up to $9.99 each) with testnet-MPC keys, which can be lost. It takes effect at once.',
                  !app.settings.mainnetDemo,
                  { done: app.settings.mainnetDemo ? 'The mainnet demo is off.' : 'The mainnet demo is on.' },
                )
              : '',
            proposePolicy.button,
          ),
      proposePolicy.box,
    ),
  );

  const now = Date.now();
  main.append(
    panel(
      'Publishable keys',
      { hint: 'The keys the partner’s pages use. Revoking one stops every page that uses it.' },
      table(
        ['Key', 'Created', 'State', ''],
        app.keys.map((k) => {
          const gone = k.revokedAt && k.revokedAt <= now;
          return tr(mono(k.key), h('span', {}, time(k.createdAt), h('span', { class: 'sub' }, `by ${k.createdBy}`)), gone ? h('span', {}, badge('Revoked'), h('span', { class: 'sub' }, time(k.revokedAt))) : k.revokedAt ? h('span', {}, badge('Retiring', 'warning'), h('span', { class: 'sub' }, `stops ${time(k.revokedAt)}`)) : badge('Active', 'ok'), gone ? '' : actionButton('Revoke now', () => api('POST', `${base}/keys/${encodeURIComponent(k.id)}/revoke`, { orgId }), 'Revoke this key now? Every page using it stops working.', true, { done: 'Key revoked.' }));
        }),
        { empty: 'No key.' },
      ),
    ),
  );

  if (!app.deleted) {
    main.append(
      panel(
        'Danger zone',
        { danger: true },
        h(
          'div',
          { class: 'stack' },
          app.suspendedBy & 1 ? '' : h('div', {}, h('p', { class: 'hint' }, 'Hana’s own switch for this app: logins stop at once, until it is lifted above.'), actionButton('Suspend this app', () => api('POST', `${base}/suspend`, { bit: 1 }), 'Suspend this app? Logins stop at once.', true, { done: 'The app is suspended by Hana.' })),
          h('div', {}, h('p', { class: 'hint' }, 'Deleting revokes every key. It can’t be undone.'), actionButton('Delete app', () => api('POST', `${base}/delete`), `Delete ${app.name}? Every key is revoked; this cannot be undone.`, true, { done: `${app.name} was deleted.` })),
        ),
      ),
    );
  }
}

/** "Put in force now": a member's change whose email went out, with who confirmed it and how (at least 20 characters). */
function expediteControl(c) {
  const d = disclosure(
    'Put in force now…',
    form(
      [{ name: 'reason', type: 'textarea', label: 'Who confirmed it, and how', placeholder: 'Aisyah (owner) confirmed on a call to her listed number, 2026-11-06 10:15 UTC', required: true, minlength: 20, size: 'wide', help: 'At least 20 characters. Kept in the audit log.' }],
      'Put in force now',
      (v) => api('POST', `/api/changes/${encodeURIComponent(c.id)}/expedite`, { reason: v.reason }),
      { confirm: 'Put this change in force now, without the rest of the waiting period?', done: 'The change is in force.', vertical: true },
    ),
  );
  d.button.classList.add('small');
  return h('div', { class: 'inline-action' }, d.button, d.box);
}

// ---- audit ----

async function auditPage(main) {
  const params = new URLSearchParams(location.search);
  const keys = ['orgId', 'appId', 'actorKind', 'actorId', 'action'];
  const labels = { orgId: 'Organisation id', appId: 'App id', actorKind: 'Done by', actorId: 'Actor id or email', action: 'Action' };
  const filterForm = h(
    'form',
    {
      class: 'form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        for (const k of keys) {
          const v = filterForm.elements[k].value.trim();
          if (v) q.set(k, v);
        }
        for (const k of ['from', 'to']) {
          const v = filterForm.elements[k].value;
          if (v) q.set(k, String(Date.parse(`${v}T00:00:00Z`)));
        }
        history.pushState(null, '', `/audit?${q}`);
        render();
      },
    },
    keys.map((k) =>
      k === 'actorKind'
        ? field({ name: k, type: 'select', label: labels[k], optional: false, value: params.get(k) || '', options: [{ value: '', label: 'Anyone' }, { value: 'hana', label: 'Hana staff' }, { value: 'member', label: 'Members' }, { value: 'system', label: 'System' }, { value: 'link', label: 'Account link' }] })
        : field({ name: k, label: labels[k], optional: false, value: params.get(k) || '', placeholder: k === 'action' ? 'e.g. invite.issue' : k === 'orgId' ? 'org_…' : '' }),
    ),
    field({ name: 'from', type: 'date', label: 'From', optional: false, size: 'narrow', value: params.get('from') ? new Date(Number(params.get('from'))).toISOString().slice(0, 10) : '' }),
    field({ name: 'to', type: 'date', label: 'To', optional: false, size: 'narrow', value: params.get('to') ? new Date(Number(params.get('to'))).toISOString().slice(0, 10) : '' }),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Filter'), [...params.keys()].length ? link('/audit', 'Clear filters') : ''),
  );
  const csv = new URLSearchParams(params);
  csv.delete('cursor');
  main.append(
    pageHead('Audit log', { subtitle: 'Who did what in the partner console and here, and every staff read of the user directory.', actions: [h('a', { href: `/api/audit.csv?${csv}`, download: true, class: 'back' }, 'Download CSV')] }),
    panel('Filter', { hint: 'The CSV has the console rows below and, with an organisation filter, its app changes too.' }, filterForm),
  );
  const data = await api('GET', `/api/audit?${params}`);
  main.append(
    panel(
      'Console audit',
      {},
      table(
        ['When', 'Action', 'Done by', 'Organisation', 'Target', 'Outcome', 'Details'],
        data.rows.map((r) => tr(h('span', {}, time(r.at), h('span', { class: 'sub' }, `#${r.seq}`)), mono(r.action), actor(r.actorKind, r.actorEmail || r.actorId), h('span', {}, mono(r.orgId || ''), r.appId ? h('span', { class: 'sub' }, r.appId) : ''), mono(r.target || ''), r.outcome === 'ok' ? badge('ok', 'ok') : badge(r.outcome, 'bad'), h('span', {}, detailPairs(r.details), h('span', { class: 'sub' }, r.requestId)))),
        { empty: 'No row matches these filters.' },
      ),
      data.next ? h('p', {}, link(`/audit?${new URLSearchParams([...[...params].filter(([k]) => k !== 'cursor'), ['cursor', data.next]])}`, 'Older rows')) : '',
    ),
    panel('App changes', {}, data.changes ? changesTable(data.changes) : emptyState('Filter by an organisation', 'Its app changes are listed here.')),
  );
  const dirForm = h(
    'form',
    {
      class: 'form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams(params);
        q.delete('dirBefore');
        for (const k of ['dirStaff', 'dirAction']) {
          const v = dirForm.elements[k].value.trim();
          if (v) q.set(k, v);
          else q.delete(k);
        }
        history.pushState(null, '', `/audit?${q}`);
        render();
      },
    },
    field({ name: 'dirStaff', label: 'Staff email', optional: false, value: params.get('dirStaff') || '' }),
    field({ name: 'dirAction', type: 'select', label: 'Action', optional: false, value: params.get('dirAction') || '', options: ['', 'user_search', 'user_view', 'support_lookup', 'client_proof', 'unlock', 'unsuppress', 'revoke_tickets'].map((a) => ({ value: a, label: a ? DIR_ACTION[a] : 'Any action' })) }),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit' }, 'Filter directory reads')),
  );
  const dir = h('section', { class: 'panel' });
  directoryAuditBlock(dir, params, data.directory);
  dir.append(dirForm);
  main.append(dir);
}

const DIR_ACTION = { user_search: 'User search', user_view: 'User opened', support_lookup: 'Support ID lookup', client_proof: 'Client proof', unlock: 'Unlock', unsuppress: 'Unsuppress', revoke_tickets: 'Revoke tickets' };

// ---- feed and notices ----

const FEED_SOURCE = { app_changes: 'App changes', security_events: 'Security events', console_audit: 'Console audit', member_notices: 'Member notices' };

async function securityPage(main) {
  const d = await api('GET', '/api/security');
  main.append(pageHead('Feed and notices', { subtitle: 'What the 5-minute job still has to email, and how far each feed has got. Normally the lists are empty and every feed is caught up.' }));
  if (d.opsError) main.append(note('warn', 'The admin’s own state couldn’t be read', d.opsError));
  const waiting = (d.notices.changes || []).length + (d.notices.members || []).length;
  main.append(
    panel(
      'Waiting to be emailed',
      { hint: 'An app change, invite or owner grant starts only once its email is accepted. The job retries every 5 minutes; something listed for longer than that means emails are failing.' },
      d.notices.changes === null
        ? note('error', 'The API didn’t answer', 'App-change notices can’t be listed. Try again in a minute.')
        : table(
            ['Change', 'App', 'Organisation', 'Proposed', { text: 'Contacts', num: true }],
            d.notices.changes.map((n) => tr(h('span', {}, CHANGE_KIND[n.kind] || n.kind, h('span', { class: 'sub' }, h('code', {}, n.changeId))), mono(n.appId), mono(n.orgId), when(n.proposedAt), String(n.contacts))),
            { empty: 'No app-change email waiting.' },
          ),
      d.notices.members === null
        ? note('error', 'The console didn’t answer', 'Invite and owner-grant notices can’t be listed. Try again in a minute.')
        : table(
            ['Notice', 'Id', 'Organisation', 'Created'],
            d.notices.members.map((n) => tr(n.kind === 'invite' ? 'Invite' : n.kind === 'grant' ? 'Owner grant' : n.kind, mono(n.id || ''), n.orgId ? mono(n.orgId) : 'New organisation', when(n.createdAt))),
            { empty: 'No invite or owner-grant email waiting.' },
          ),
      waiting ? '' : h('p', { class: 'hint' }, 'Everything has been emailed.'),
    ),
    panel(
      'Security events not yet emailed',
      {},
      d.unnotifiedEvents === null ? note('error', 'The API didn’t answer', 'Try again in a minute.') : table(['Detected', 'Kind', 'Organisation', 'App', 'Scope', 'Details'], d.unnotifiedEvents.map((e) => tr(when(e.detectedAt), h('span', {}, mono(e.kind), h('span', { class: 'sub' }, e.id)), mono(e.orgId || ''), mono(e.appId || ''), mono(e.scopeId || ''), detailPairs(e.detail))), { empty: 'None: every security event has been emailed.' }),
    ),
    panel(
      'Feeds',
      { hint: 'Each feed emails new rows of its source to the security contacts. “Behind by” is how old its oldest unsent row is.' },
      d.feed ? table(['Source', 'Position', 'Last moved', 'Behind by'], Object.entries(d.feed).map(([k, v]) => tr(FEED_SOURCE[k] || k, mono(String(v.cursor)), v.updatedAt ? when(v.updatedAt) : 'never', v.lagMs === null ? 'unknown' : v.lagMs === 0 ? badge('Caught up', 'ok') : badge(`${Math.round(v.lagMs / 60000)} min`, 'warning')))) : note('warn', 'The feeds can’t be read right now', ''),
      h('h3', {}, 'On-chain watcher'),
      h('p', {}, d.watcher ? ['Reads each scope on chain and emails a proposal nobody announced. Next scope after ', mono(d.watcher.cursor || '(the start)'), `; last moved ${d.watcher.updatedAt ? `${time(d.watcher.updatedAt)} (${relative(d.watcher.updatedAt)})` : 'never'}.`] : 'Unavailable.'),
      h('h3', {}, 'Last run of the job'),
      d.lastRun ? h('details', { class: 'raw' }, h('summary', {}, `Finished ${d.lastRun.at ? relative(d.lastRun.at) : ''}: show what it did`), h('pre', {}, JSON.stringify(d.lastRun, null, 2))) : h('p', { class: 'muted' }, 'No run recorded yet.'),
    ),
  );
  ledgerSecurity(main, d.ledger);
}

// ---- Security & monitoring, pending upgrades, playbooks (C14) ----
//
// Every value below comes from the admin Worker, which reduced the watchdog's answers to bounded plain data; it is
// written as text like everything else. Links are only those the Worker built (playbook pages, the repo's docs,
// explorer links of validated transaction hashes), and an external one is set only when it is https.

/** "in 2 h 5 min" / "due 3 min ago" from a time in ms (the reader's clock, as the API's countdowns intend). */
function countdown(atMs) {
  if (typeof atMs !== 'number') return '';
  const d = atMs - Date.now();
  return d > 0 ? `in ${span(d)} (${time(atMs)})` : `due ${span(d)} ago (${time(atMs)})`;
}

const SEVERITY = { critical: 'Critical', warning: 'Warning', info: 'Info' };
const sev = (s) => badge(SEVERITY[s] || s, s);
const external = (href, text) => (typeof href === 'string' && href.startsWith('https://') ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);
const playbookLink = (p) => (p ? link(`/security/playbooks/${encodeURIComponent(p.id)}`, p.title) : h('span', { class: 'error' }, 'no playbook'));
const plainJson = (v) => h('pre', {}, v === null || v === undefined ? 'None' : JSON.stringify(v, null, 2));

/** Text with `backtick` spans shown as code (each span is text in a <code>, never markup). */
function richText(s) {
  return String(s)
    .split('`')
    .map((part, i) => (i % 2 ? h('code', {}, part) : part));
}

/** A command in a copyable block, verbatim (placeholders such as <env> stay as they are). */
function commandBlock(cmd) {
  const status = h('span', { class: 'muted', role: 'status' });
  return h(
    'div',
    { class: 'command' },
    h('pre', {}, h('code', {}, cmd)),
    h(
      'button',
      {
        type: 'button',
        class: 'small',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            status.textContent = 'Copied';
          } catch {
            status.textContent = 'Copy failed: select the text instead';
          }
        },
      },
      'Copy',
    ),
    status,
  );
}

function sourceError(what, part) {
  const e = explain(new ApiError(0, part.code, ''));
  return note('error', `${what} is unavailable`, e.title === 'The request failed' ? '' : `${e.title}. ${e.hint}`, h('p', { class: 'code' }, 'Error code ', h('code', {}, part.code)));
}

function alertsTable(alerts, opts = {}) {
  return table(
    ['Alert', 'Severity', 'Raised', 'State', 'Re-sends', 'Acknowledged', 'Playbook', ''],
    alerts.map((a) =>
      tr(
        h('span', {}, h('strong', {}, `#${a.id} `), a.title, h('span', { class: 'sub' }, h('code', {}, a.kind))),
        sev(a.severity),
        when(a.createdAt),
        a.open ? badge('Open', 'bad') : h('span', {}, 'Resolved', h('span', { class: 'sub' }, time(a.resolvedAt))),
        a.resendsUntilAck ? h('span', {}, `${a.sendCount ?? 0} sent`, h('span', { class: 'sub' }, `last ${time(a.lastSentAt)}`)) : h('span', { class: 'muted' }, 'none (not critical)'),
        a.ackedAt ? h('span', {}, time(a.ackedAt), h('span', { class: 'sub' }, `by ${a.ackedBy || '?'} via ${a.ackedVia || '?'}`)) : 'No',
        playbookLink(a.playbook),
        h(
          'div',
          { class: 'cell-actions' },
          a.canAck
            ? actionButton(
                'Acknowledge',
                () => api('POST', `/api/monitoring/alerts/${encodeURIComponent(a.id)}/ack`),
                `Acknowledge alert #${a.id} (${a.kind})? This only stops its 15-minute re-sends. It does not clear the condition, and the watchdog keeps checking. Your Access identity is recorded.`,
                false,
                { done: `Alert #${a.id} acknowledged: its re-sends stop. The condition is still checked.` },
              )
            : '',
          opts.details ? h('details', { class: 'raw' }, h('summary', {}, 'Details and deliveries'), plainJson(a.details), h('p', { class: 'muted' }, `Deliveries: the last ${a.deliveries.length} of ${a.deliveriesTotal}`), plainJson(a.deliveries)) : '',
        ),
      ),
    ),
    { empty: opts.empty || 'No alert.' },
  );
}

function actionsTable(actions) {
  return table(
    ['When', 'What', 'Why', 'Result', 'Transaction', 'Arguments'],
    actions.map((x) => tr(h('span', {}, time(x.at), h('span', { class: 'sub' }, `#${x.id}`)), mono(x.method), x.reason || '', x.ok ? badge('ok', 'ok') : h('span', {}, badge('Failed', 'bad'), x.error ? h('span', { class: 'sub' }, x.error) : ''), x.txHash ? external(x.txUrl, x.txHash) : '', detailPairs(x.args))),
    { empty: 'The watchdog hasn’t acted on chain.' },
  );
}

async function monitoringPage(main) {
  const params = new URLSearchParams(location.search);
  const alertsQuery = new URLSearchParams();
  for (const k of ['cursor', 'severity']) if (params.get(k)) alertsQuery.set(k, params.get(k));
  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  const [d, alertPage, actions] = await Promise.all([api('GET', '/api/monitoring'), settle(api('GET', `/api/monitoring/alerts?${alertsQuery}`)), settle(api('GET', `/api/monitoring/actions${params.get('actionsCursor') ? `?cursor=${encodeURIComponent(params.get('actionsCursor'))}` : ''}`))]);
  const w = d.watchdog;
  const g = d.governance;
  main.append(pageHead('Security & monitoring', { subtitle: `The watchdog and the contract for ${d.env}, read ${time(d.now)}. The watchdog sends its own alerts; nothing on this page alerts or acts on chain.` }));
  if (w.ok && w.silent) main.append(h('p', { class: 'banner critical', role: 'alert' }, w.sinceLastRunMs === null ? 'The watchdog has never finished a run. ' : `The watchdog has been silent for ${Math.round(w.sinceLastRunMs / 60000)} min: more than two ${Math.round(w.runIntervalMs / 60000)}-minute intervals. `, link('/security/playbooks/watchdog-down', 'Playbook: watchdog down')));

  main.append(
    panel(
      'Needs attention',
      {},
      d.findings.length ? h('ul', { class: 'findings' }, d.findings.map((f) => h('li', {}, sev(f.severity), h('span', {}, f.text, h('span', { class: 'muted' }, ` (${f.source})`)), f.playbook ? playbookLink(f.playbook) : ''))) : emptyState('Nothing needs attention', 'The watchdog and the contract look as expected.'),
    ),
  );

  if (!w.ok) main.append(panel('Watchdog', {}, sourceError('The watchdog status', w)));
  else {
    const hb = w.heartbeat || {};
    main.append(
      panel(
        'Open alerts',
        { hint: 'Critical alerts are re-sent every 15 minutes until someone acknowledges them.' },
        alertsTable(w.openAlerts, { empty: 'No open alert.' }),
      ),
      panel(
        'Watchdog',
        {},
        h(
          'div',
          { class: 'stat-row' },
          stat('Last run', w.lastRun ? `${relative(w.lastRun.finishedAt)} (#${w.lastRun.id}, ${w.lastRun.outcome || 'no outcome'})` : 'never'),
          stat('Heartbeat', hb.configured === false ? 'not configured' : hb.ok ? `ok, ${relative(hb.last_ok_at)}` : `failing since ${time(hb.last_ok_at)}`),
          stat(
            'Alert channels',
            Object.entries(w.channels || {})
              .map(([k, v]) => `${k} ${v && v.configured ? 'on' : 'off'}`)
              .join(', '),
          ),
          stat('Account', h('code', {}, w.watchdogAccount || '')),
          stat('Network', w.network || ''),
        ),
        h('h3', {}, 'Checks of the last run'),
        table(['Check', 'Outcome', 'Detail', 'Shown in'], w.checks.map((c) => tr(c.known ? h('span', {}, c.title, h('span', { class: 'sub' }, h('code', {}, c.id))) : h('span', { class: 'error' }, `${c.id} (no portal rendering)`), c.outcome === 'ok' ? badge('ok', 'ok') : c.outcome ? badge(c.outcome, 'bad') : h('span', { class: 'muted' }, 'not reported'), c.detail || '', c.shownIn || ''))),
      ),
    );
  }

  if (!g.ok) main.append(panel('Contract governance', {}, sourceError('The governance state', g)));
  else {
    const pendingRows = [
      g.pendingUpgrade ? tr('Contract upgrade', mono(g.pendingUpgrade.codeHash), countdown(g.pendingUpgrade.executableAtMs)) : null,
      g.pendingOwner ? tr('Owner transfer', mono(g.pendingOwner.owner), countdown(g.pendingOwner.acceptableAtMs)) : null,
      g.pendingWithdrawal ? tr('Withdrawal', `${near(g.pendingWithdrawal.amountYocto)} NEAR to ${g.pendingWithdrawal.receiver}`, countdown(g.pendingWithdrawal.executableAtMs)) : null,
      ...['pendingIssuerKeyDelay', 'pendingGovernanceDelay', 'pendingChangeDelay'].filter((k) => g.delays && g.delays[k]).map((k) => tr('Shorter delay', `${k}: ${span(g.delays[k].valueMs)}`, countdown(g.delays[k].effectiveAtMs))),
      ...(g.pendingConsoleAudiences || []).map((a) => tr('Console audience', `${a.provider} ${a.aud}`, countdown(a.effectiveAtMs))),
    ];
    main.append(
      panel(
        'Contract governance',
        { hint: `Read ${time(g.readAtMs)}, state version ${g.stateVersion}.` },
        h(
          'div',
          { class: 'stat-row' },
          stat('Contract', g.pause.paused ? badge('Paused', 'critical') : badge('Not paused', 'ok')),
          g.pause.unpausedAtMs ? stat('Last unpaused', time(g.pause.unpausedAtMs)) : '',
          g.pause.lastWatchdogPause ? stat('Last watchdog pause', `${time(g.pause.lastWatchdogPause.at)} (${g.pause.lastWatchdogPause.reason || 'no reason given'})`) : '',
        ),
        h('h3', {}, 'Queued owner actions'),
        table(['What', 'Detail', 'When'], pendingRows, { empty: 'Nothing queued.' }),
        h('p', { class: 'hint' }, link('/security/upgrades', 'Pending upgrades'), ': what partners see, with how to check a release.'),
        h('h3', {}, 'Pending Google key changes'),
        table(['Change', 'Key id', 'Proposed by', 'Executable', 'Google publishes it', 'Watchdog saw it'], (g.keyChanges || []).map((c) => tr(`#${c.id} ${c.op} (${c.provider})`, mono(c.kid), mono(c.by), countdown(c.executableAtMs), c.jwks, c.watchdogSeen ? `since ${time(c.watchdogSeen.firstSeenAt)}` : h('span', { class: 'error' }, 'never'))), { empty: 'No key change pending.' }),
        h('h3', {}, 'Updater keys on the signer account'),
        table(['Updater key', 'On the signer account', 'Permission'], (g.updaterKeyCheck || []).map((k) => tr(mono(k.publicKey), k.onAccount === null ? 'unknown' : k.onAccount ? badge('yes', 'ok') : badge('missing', 'bad'), k.permissionOk === null ? '' : k.permissionOk ? badge('ok', 'ok') : badge('wrong', 'bad')))),
        table(['Other signer key', 'Kind', 'Receiver', 'Methods'], (g.otherSignerKeys || []).map((k) => tr(mono(k.publicKey), k.kind, k.receiverId || '', (k.methodNames || []).join(', '))), { empty: 'No other key.' }),
        h('h3', {}, 'Watchdogs on chain'),
        table(['Account', 'May confirm from', 'Can confirm'], (g.watchdogs || []).map((x) => tr(mono(x.accountId), time(x.confirmFromMs), x.canConfirm ? 'yes' : 'not yet'))),
        h('details', { class: 'raw' }, h('summary', {}, 'The API’s Google-key job'), plainJson(g.updater)),
      ),
    );
  }

  const sevForm = h(
    'form',
    {
      class: 'form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        if (sevForm.elements.severity.value) q.set('severity', sevForm.elements.severity.value);
        window.history.pushState(null, '', `/security/monitoring?${q}`);
        render();
      },
    },
    field({ name: 'severity', type: 'select', label: 'Severity', optional: false, size: 'narrow', value: params.get('severity') || '', options: [{ value: '', label: 'All' }, { value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }] }),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit' }, 'Filter')),
  );
  const history_ = panel('Alert history', {}, sevForm);
  if (!alertPage.ok) history_.append(errorBox(alertPage.e));
  else {
    history_.append(alertsTable(alertPage.v.alerts, { details: true, empty: 'No alert of this severity.' }));
    if (alertPage.v.nextCursor) {
      const next = new URLSearchParams(params);
      next.set('cursor', String(alertPage.v.nextCursor));
      history_.append(h('p', {}, link(`/security/monitoring?${next}`, 'Older alerts')));
    }
  }
  const acts = panel('What the watchdog did on chain', {});
  if (!actions.ok) acts.append(errorBox(actions.e));
  else {
    acts.append(actionsTable(actions.v.actions));
    if (actions.v.nextCursor) {
      const next = new URLSearchParams(params);
      next.set('actionsCursor', String(actions.v.nextCursor));
      acts.append(h('p', {}, link(`/security/monitoring?${next}`, 'Older actions')));
    }
  }
  main.append(history_, acts);

  if (w.ok) {
    main.append(
      panel(
        'More from the watchdog',
        {},
        h('h3', {}, 'Google signing keys seen'),
        table(['Provider', 'Key id', 'Source', 'First seen', 'Last seen'], w.seenKids.map((k) => tr(k.provider || '', mono(k.kid || ''), k.source || '', time(k.firstSeenAt), time(k.lastSeenAt)))),
        h('details', { class: 'raw' }, h('summary', {}, 'Relayer funds'), plainJson(w.relayerFunds)),
        h('details', { class: 'raw' }, h('summary', {}, 'Email issuer keys and the chain'), plainJson(w.email)),
        h('details', { class: 'raw' }, h('summary', {}, 'Identity token keys'), plainJson(w.identity)),
        h('details', { class: 'raw' }, h('summary', {}, 'Account link stats'), plainJson(w.linkStats)),
        h('h3', {}, 'Alert kinds and their playbooks'),
        table(['Kind', 'Severity', 'Check', 'What it means', 'Playbook'], w.alertKinds.map((k) => tr(mono(k.kind), sev(k.severity), mono(k.check || ''), k.description || '', playbookLink(k.playbook)))),
      ),
    );
  }
  main.append(panel('Security events', {}, d.events.ok ? table(['Detected', 'Kind', 'Organisation', 'App', 'Scope', 'Emailed', 'Details'], d.events.events.map((e) => tr(when(e.detectedAt), h('span', {}, mono(e.kind), h('span', { class: 'sub' }, e.id)), mono(e.orgId || ''), mono(e.appId || ''), mono(e.scopeId || ''), e.notifiedAt ? time(e.notifiedAt) : badge('not yet', 'warning'), detailPairs(e.detail))), { empty: 'No security event.' }) : sourceError('The security events', d.events)));
}

const stat = (label, value) => h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value));

// ---- System status (D425): the landing page, a bird's-eye view of the whole env ----
//
// One verdict ("All systems operational" only when every check answered and passed), the issues critical first with
// what each affects, since when, what to do and where, then one tile per component. Read-only: its one button reads
// again. Unknown is grey and never green; "Not measured" is listed as a follow-up, not as an issue.

const TILE_STATE = {
  ok: { label: 'OK', cls: 'ok' },
  warning: { label: 'Warning', cls: 'warning' },
  critical: { label: 'Critical', cls: 'critical' },
  unknown: { label: 'Unknown', cls: 'unknown' },
  not_measured: { label: 'Not measured', cls: 'off' },
};
const tileState = (s) => TILE_STATE[s] || TILE_STATE.unknown;

/** "12 s ago" from the reader's clock; refreshed in place every few seconds while the page is open. */
const agoText = (ms) => {
  const d = Math.max(0, Date.now() - ms);
  return d < 90_000 ? `${Math.round(d / 1000)} s ago` : `${roughly(d)} ago`;
};
const liveAgo = (ms, prefix) => h('span', { class: 'ago', 'data-at': String(ms), 'data-prefix': prefix || '' }, `${prefix || ''}${agoText(ms)}`);
let statusTicker = null;
function stopStatusTicker() {
  if (statusTicker !== null) clearInterval(statusTicker);
  statusTicker = null;
}
function startStatusTicker() {
  stopStatusTicker();
  statusTicker = setInterval(() => {
    const spans = document.querySelectorAll('#app .ago[data-at]');
    if (!spans.length) return stopStatusTicker();
    for (const el of spans) el.textContent = `${el.getAttribute('data-prefix') || ''}${agoText(Number(el.getAttribute('data-at')))}`;
  }, 5_000);
}

/** Only the console's own paths are links (the answer is ours, but a path is checked before it becomes an href). */
const pathLink = (l) => (l && typeof l.path === 'string' && /^\/[a-z0-9/_-]*$/u.test(l.path) ? link(l.path, l.label) : '');

function verdictBanner(d) {
  const v = d.verdict;
  const tiles = d.groups.flatMap((g) => g.tiles);
  const passed = tiles.filter((t) => t.state === 'ok').length;
  const off = tiles.filter((t) => t.state === 'not_measured').length;
  const unknown = tiles.filter((t) => t.state === 'unknown').length;
  const parts = [`${passed} of ${tiles.length - off} checks passed`];
  if (unknown) parts.push(`${unknown} unknown`);
  if (off) parts.push(`${off} not measured or not part of this env`);
  const counts = v.state === 'ok' ? '' : [v.critical ? `${v.critical} critical` : '', v.warning ? `${v.warning} warning${v.warning === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  return h(
    'section',
    { class: `verdict ${v.state}`, role: 'status', 'aria-live': 'polite', 'aria-labelledby': 'verdict-title' },
    h('span', { class: 'verdict-mark', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'verdict-text' },
      h('h2', { id: 'verdict-title' }, v.state === 'ok' ? 'All systems operational' : `${d.issues.length} issue${d.issues.length === 1 ? '' : 's'}`),
      h('p', {}, v.state === 'ok' ? 'Every check answered and passed.' : `${counts}. ${v.critical ? 'Critical first below' : 'Listed below'}, each with what to do.`),
      h('p', { class: 'verdict-meta' }, `Checked ${time(d.checkedAt)} · `, liveAgo(d.checkedAt), ` · ${parts.join(' · ')}`),
    ),
  );
}

function issueItem(i) {
  return h(
    'li',
    { class: `issue ${i.severity}` },
    h('div', { class: 'issue-head' }, sev(i.severity), h('strong', {}, i.title)),
    h(
      'dl',
      { class: 'issue-facts' },
      h('div', {}, h('dt', {}, 'Affects'), h('dd', {}, i.affects)),
      h('div', {}, h('dt', {}, i.sinceSource === 'source' ? 'Since' : 'First seen'), h('dd', {}, h('time', { datetime: new Date(i.since).toISOString() }, time(i.since)), ' ', h('span', { class: 'muted' }, `(${relative(i.since)}${i.sinceSource === 'source' ? '' : ', by this console'})`))),
      h('div', {}, h('dt', {}, 'Where'), h('dd', {}, i.componentName)),
    ),
    i.action ? h('p', { class: 'issue-action' }, richText(i.action)) : '',
    i.link || i.playbook ? h('p', { class: 'issue-links' }, pathLink(i.link), i.link && i.playbook ? ' · ' : '', i.playbook ? h('span', {}, 'Playbook: ', playbookLink(i.playbook)) : '') : '',
  );
}

function tileItem(t, checkedAt) {
  const s = tileState(t.state);
  return h(
    'li',
    { class: `tile ${s.cls}` },
    h('div', { class: 'tile-head' }, h('span', { class: `state-chip ${s.cls}` }, s.label), h('h3', {}, t.name)),
    h('p', { class: 'tile-detail' }, t.detail),
    h('p', { class: 'tile-meta' }, liveAgo(checkedAt, 'checked '), t.link ? h('span', {}, ' · ', pathLink(t.link)) : ''),
  );
}

async function statusPage(main) {
  const d = await api('GET', '/api/status');
  main.append(
    pageHead('System status', {
      subtitle: `Every part of ${d.env}: its Workers, the contract and the watchdog, funds, data, scheduled jobs and outside services. Read only; nothing here changes anything.`,
      actions: [h('button', { type: 'button', class: 'primary', onclick: () => render() }, 'Check again')],
    }),
    verdictBanner(d),
  );
  if (d.cached) main.append(h('p', { class: 'hint' }, `This is the read from ${agoText(d.checkedAt)}: the console reads every part at most every ${Math.round(d.cacheMs / 1000)} s, so a refresh costs nothing. Check again after that for a fresh read.`));
  if (d.issues.length) {
    main.append(panel('Issues', { hint: 'Critical first. Each says what it affects, since when, and what to do.' }, h('ol', { class: 'issues' }, d.issues.map(issueItem))));
  }
  for (const g of d.groups) {
    if (!g.tiles.length) continue;
    const bad = g.tiles.filter((t) => t.state === 'critical' || t.state === 'warning' || t.state === 'unknown').length;
    main.append(panel(g.title, { hint: bad ? `${bad} of ${g.tiles.length} need${bad === 1 ? 's' : ''} a look.` : undefined }, h('ul', { class: 'tiles' }, g.tiles.map((t) => tileItem(t, d.checkedAt)))));
  }
  if (d.notMeasured && d.notMeasured.length) {
    main.append(panel('Not measured yet', { hint: 'Nothing on this page measures these yet; they aren’t counted as issues. Each says why and how to check it meanwhile.' }, h('ul', { class: 'not-measured' }, d.notMeasured.map((n) => h('li', {}, h('strong', {}, n.what), h('span', {}, richText(n.why)))))));
  }
  startStatusTicker();
}

async function upgradesPage(main) {
  const { pendingUpgrades: p } = await api('GET', '/api/governance/pending-upgrades');
  main.append(pageHead('Pending upgrades', { subtitle: `What the contract owner has queued for ${p.signer} (${p.env}), read ${time(p.readAtMs)}. Partners see the same page. Each waits the governance delay (${span(p.governanceDelayMs)}) so partners and users can react, for example by exporting keys.` }));
  if (p.paused) main.append(h('p', { class: 'banner critical', role: 'alert' }, 'The contract is paused.'));
  if (!p.anyPending) main.append(panel('Nothing is pending', {}, emptyState('Nothing is pending', 'No upgrade, owner transfer, withdrawal or delay change is queued.')));
  if (p.upgrade) {
    const u = p.upgrade;
    main.append(
      panel(
        'Contract upgrade',
        {},
        facts([
          ['Code hash', mono(u.codeHash)],
          ['Proposed', time(u.proposedAtMs)],
          ['Can be executed', countdown(u.executableAtMs)],
        ]),
        u.release
          ? [
              h('p', {}, `Release ${u.release.version}, source commit `, mono(u.release.commit), '. Rebuild it and compare the hash:'),
              commandBlock(u.release.buildCommand),
              u.release.diffCommand ? [h('p', {}, 'What changed since the last release:'), commandBlock(u.release.diffCommand)] : h('p', { class: 'muted' }, 'The first published release: no earlier release to compare with.'),
            ]
          : note('warn', 'Not a published release', 'No source commit or reproducible-build command is on record for this code hash. Treat it as unexplained until it is published.'),
      ),
    );
  }
  if (p.ownerTransfer) main.append(panel('Owner transfer', {}, table(['New owner', 'Can be accepted'], [tr(mono(p.ownerTransfer.owner), countdown(p.ownerTransfer.acceptableAtMs))])));
  if (p.withdrawal) main.append(panel('Withdrawal', {}, table(['Receiver', 'Amount (NEAR)', 'Can be executed'], [tr(mono(p.withdrawal.receiver), near(p.withdrawal.amountYocto), countdown(p.withdrawal.executableAtMs))])));
  if (p.delayDecreases.length) main.append(panel('Shorter delays', {}, table(['Delay', 'Now', 'Becomes', 'Effective'], p.delayDecreases.map((x) => tr(x.delay, span(x.currentMs), span(x.valueMs), countdown(x.effectiveAtMs))))));
  if (p.consoleAudienceAdditions.length) main.append(panel('New console sign-in clients', {}, table(['Provider', 'Audience', 'Effective'], p.consoleAudienceAdditions.map((x) => tr(x.provider, mono(x.aud), countdown(x.effectiveAtMs))))));
}

async function playbooksPage(main) {
  const params = new URLSearchParams(location.search);
  const d = await api('GET', `/api/playbooks?${params}`);
  const filter = h(
    'form',
    {
      class: 'form',
      role: 'search',
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        for (const k of ['q', 'kind', 'severity']) if (filter.elements[k].value.trim()) q.set(k, filter.elements[k].value.trim());
        history.pushState(null, '', `/security/playbooks?${q}`);
        render();
      },
    },
    field({ name: 'q', type: 'search', label: 'Search', optional: false, value: params.get('q') || '', placeholder: 'e.g. relayer, paused, key' }),
    field({ name: 'kind', type: 'select', label: 'Type', optional: false, size: 'narrow', value: params.get('kind') || '', options: [{ value: '', label: 'All' }, { value: 'alert', label: 'Alerts' }, { value: 'incident', label: 'Incidents' }] }),
    field({ name: 'severity', type: 'select', label: 'Severity', optional: false, size: 'narrow', value: params.get('severity') || '', options: [{ value: '', label: 'All' }, { value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }] }),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Search')),
  );
  main.append(
    pageHead('Playbooks', { subtitle: `What to do when an alert fires or an incident happens (last verified ${d.lastVerified}). Read-only: owner calls stay in scripts/ and the council’s own signing.` }),
    panel('Find a playbook', {}, filter),
    panel(
      `${d.playbooks.length} playbook${d.playbooks.length === 1 ? '' : 's'}`,
      {},
      table(
        ['Playbook', 'Severity', 'What it covers', 'Alert kinds'],
        d.playbooks.map((p) => tr(h('span', {}, link(`/security/playbooks/${encodeURIComponent(p.id)}`, p.title), h('span', { class: 'sub' }, p.kind === 'incident' ? 'Incident' : 'Alert', p.status === 'planned' ? [' ', badge('planned: not built yet', 'warning')] : '')), sev(p.severity), p.summary, h('span', {}, p.alertKinds.map((k, i) => [i ? ', ' : '', h('code', {}, k)])))),
        { empty: 'No playbook matches. Try fewer words.' },
      ),
    ),
  );
}

async function playbookPage(main, id) {
  const { notes, playbook: p } = await api('GET', `/api/playbooks/${encodeURIComponent(id)}`);
  const list = (items) => (items.length ? h('ul', {}, items.map((x) => h('li', {}, richText(x)))) : h('p', { class: 'muted' }, 'None'));
  main.append(
    pageHead(p.title, { back: { href: '/security/playbooks', text: 'Playbooks' }, subtitle: p.summary, meta: [sev(p.severity), badge(p.kind === 'incident' ? 'Incident' : 'Alert'), p.status === 'planned' ? badge('planned: not built yet', 'warning') : '', p.alertKinds.length ? h('span', {}, 'Alert kinds: ', p.alertKinds.map((k, i) => [i ? ', ' : '', h('code', {}, k)])) : ''] }),
    note('info', 'Before you start', h('ul', {}, notes.map((n) => h('li', {}, richText(n))))),
    h('div', { class: 'cols' }, panel('Signals', {}, list(p.signals)), panel('Impact', {}, list(p.impact))),
    panel('Steps', {}, h('ol', { class: 'steps' }, p.steps.map((s) => h('li', {}, h('p', {}, badge(s.who, 'who'), ' ', h('strong', {}, s.title)), h('p', {}, richText(s.detail)), s.commands.map(commandBlock))))),
    h('div', { class: 'cols' }, panel('Verify', {}, list(p.verify)), panel('Follow-ups', {}, list(p.followUps))),
    h('div', { class: 'cols' }, panel('References', {}, h('ul', {}, p.refs.map((r) => h('li', {}, external(r.href, r.ref))))), panel('Related playbooks', {}, p.related.length ? h('ul', {}, p.related.map((r) => h('li', {}, link(`/security/playbooks/${encodeURIComponent(r.id)}`, r.title)))) : h('p', { class: 'muted' }, 'None'))),
  );
}

/** The usage ledger's part of the security screen (C12): nonce checks, rejection and settlement alerts, partitions. */
function ledgerSecurity(main, l) {
  if (!l || l.error) {
    main.append(panel('Usage ledger', {}, note('warn', 'The usage ledger can’t be read', l && l.error ? l.error : 'In an environment without usage capture this is expected.')));
    return;
  }
  main.append(
    panel(
      'Usage ledger',
      { hint: 'Billing checks: every relayed transaction is settled and explained.' },
      l.relayerAccountSet ? '' : note('warn', 'Settlement isn’t running', 'RELAYER_ACCOUNT is not set: settlement and the nonce check do not run.'),
      l.partitionsLow ? note('warn', `Only ${l.partitionsAhead} future monthly partition(s) of usage events`, 'An event outside every partition is lost. Check the API’s and the admin’s partition jobs.') : '',
      h(
        'div',
        { class: 'stat-row' },
        stat('Future monthly partitions', String(l.partitionsAhead)),
        stat('Waiting for settlement', `${l.settlementBacklog.pending} relayed event(s)${l.settlementBacklog.oldestAt ? `, oldest ${relative(l.settlementBacklog.oldestAt)}` : ''}`),
      ),
      h('h3', {}, 'Nonce check (latest per relayer key)'),
      h('p', { class: 'hint' }, 'Each relayer key’s newest on-chain transaction must be in the ledger. An unexplained one may mean a leaked relayer key.'),
      table(
        ['Relayer key', 'Checked', 'Nonce on chain', 'Result', { text: 'Ledger rows since last', num: true }, 'Alerted'],
        l.nonceChecks.map((n) => tr(mono(n.relayerPk), time(n.checkedAt), mono(n.chainNonce), n.explained ? badge('Explained', 'ok') : h('strong', { class: 'error' }, 'UNEXPLAINED'), String(n.ledgerRelayedSinceLast), n.alertedAt ? time(n.alertedAt) : n.explained ? '' : 'not yet')),
        { empty: 'No check has run yet.' },
      ),
      h('h3', {}, 'High rejection rates'),
      table(
        ['Organisation', 'Day', { text: 'Relayed', num: true }, { text: 'Rejected after relay', num: true }, 'Alerted'],
        l.rejectionAlerts.map((a) => tr(mono(a.orgId), a.day, String(a.relayed), `${a.rejected} (${((a.rejected * 100) / Math.max(1, a.relayed)).toFixed(1)}%)`, a.alertedAt ? time(a.alertedAt) : 'not yet')),
        { empty: 'None.' },
      ),
      h('h3', {}, 'Settlement refusals (not billed)'),
      h('p', { class: 'hint' }, 'A relayed event is billed only when its transaction is its own: no other event carries it, and it is signed by the event’s pool key at its nonce.'),
      table(
        ['Detected', 'Reason', 'Organisation', 'Request', 'Event time', 'Transaction', 'Details', 'Alerted'],
        l.settlementAlerts.map((a) => tr(time(a.detectedAt), a.reason, mono(a.orgId), mono(a.requestId), time(a.at), mono(a.nearTx), detailPairs(a.detail), a.alertedAt ? time(a.alertedAt) : 'not yet')),
        { empty: 'None.' },
      ),
    ),
  );
}

// ---- reports, statements, rates (C12) ----

async function reportsPage(main) {
  const params = new URLSearchParams(location.search);
  const first = `${thisMonth()}-01`;
  const options = await orgOptions();
  main.append(
    pageHead('Usage reports', { subtitle: 'Logins, derives and gas per app and day or month, for one organisation.' }),
    panel(
      'Choose',
      { hint: 'At most 400 days and 100 apps. Gas is settled gas at FINAL; unsettled events are never billed. Events received after the month’s statement are flagged as late.' },
      queryForm(
        '/reports',
        [
          { name: 'org', label: 'Organisation', type: 'select', options: [{ value: '', label: 'Choose an organisation' }, ...options] },
          { name: 'from', label: 'From', type: 'date', value: first, size: 'narrow' },
          { name: 'to', label: 'To', type: 'date', value: today(), size: 'narrow' },
          { name: 'by', label: 'Per', type: 'select', options: [{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }], size: 'narrow' },
          { name: 'apps', label: 'Only these apps', placeholder: 'app ids, comma separated', optional: true },
        ],
        'Show report',
      ),
    ),
  );
  const org = params.get('org');
  if (!org) {
    main.append(emptyState('Choose an organisation', 'Its usage for the dates you pick is shown here.'));
    return;
  }
  const q = new URLSearchParams({ org, from: params.get('from') || first, to: params.get('to') || today(), by: params.get('by') || 'day' });
  if (params.get('apps')) q.set('apps', lines(params.get('apps')).join(','));
  const d = await api('GET', `/api/reports?${q}`);
  const x = (text) => ({ text, extra: true, num: true });
  const n = (text) => ({ text, num: true });
  const wrap = table(
    ['Period', 'App or scope', n('Logins'), n('Derives'), x('Owner actions'), x('Link actions'), x('Identity tokens'), n('Active users'), n('New users'), n('Tgas'), x('Rejected Tgas'), x('Error Tgas'), n('NEAR'), n('USD'), n('Login p50 ms'), n('Login p95 ms'), 'Failures', n('Unsettled'), n('After statement')],
    d.rows.map((r) => {
      const cells = [
        h('span', { class: 'nw' }, r.period),
        r.appId ? mono(r.appId) : h('span', {}, 'Owner actions', h('span', { class: 'sub' }, h('code', {}, r.scopeId))),
        String(r.logins),
        String(r.derives),
        String(r.ownerActions),
        String(r.linkActions ?? 0),
        String(r.identityTokens ?? 0),
        String(r.activeUsers ?? ''),
        String(r.newUsers),
        r.tgas,
        r.relayedRejectedTgas,
        r.errorTgas,
        near(r.burntYocto),
        usd(r.usdMicros),
        r.p50.login === undefined ? '' : String(r.p50.login),
        r.p95.login === undefined ? '' : String(r.p95.login),
        detailPairs(r.failuresByCode),
        r.unsettled ? h('strong', {}, String(r.unsettled)) : '0',
        r.afterStatement ? h('strong', { class: 'warn' }, `${r.afterStatement} late`) : '0',
      ];
      const extra = new Set([4, 5, 6, 10, 11]);
      const numeric = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18]);
      return h('tr', {}, cells.map((c, i) => h('td', { class: [extra.has(i) ? 'extra' : '', numeric.has(i) ? 'num' : ''].filter(Boolean).join(' ') || undefined }, c)));
    }),
    { class: 'compact', empty: 'No usage in this period.' },
  );
  const toggle = h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (ev) => wrap.classList.toggle('compact', !ev.target.checked) }), 'Show every column');
  main.append(panel(`Usage of ${(options.find((o) => o.value === org) || { label: org }).label}`, { actions: [toggle] }, wrap));
}

/** The on-screen statement (D92): the same labels and values as its PDF. */
function statementBlock(st, view) {
  return panel(
    view.title,
    {},
    note('info', 'Statement hash (SHA-256 of the CSV)', h('p', {}, h('code', {}, st.csvSha256))),
    facts(view.header),
    table(['App or scope', ...view.tableColumns.map((c) => ({ text: c, num: true }))], view.table.map((r) => h('tr', {}, h('td', {}, r.label), r.cells.map((c) => h('td', { class: 'num' }, c))))),
    facts(view.summary.map(([k, v]) => [k, k.startsWith('Billed') ? h('strong', {}, v) : v])),
    view.notes.map((n) => h('p', { class: 'hint' }, n)),
    h('p', { class: 'hint' }, `Issued ${time(st.issuedAt)} by ${st.issuedBy}`, st.pdfSha256 ? ['. PDF SHA-256 ', h('code', {}, st.pdfSha256)] : ''),
  );
}

async function statementsPage(main) {
  const params = new URLSearchParams(location.search);
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  main.append(
    pageHead('Monthly statements', { subtitle: 'Issue, read and download an organisation’s frozen monthly statement, and export its ledger.' }),
    panel(
      'Choose',
      {},
      queryForm(
        '/statements',
        [
          { name: 'org', label: 'Organisation', type: 'select', options: [{ value: '', label: 'Choose an organisation' }, ...(await orgOptions())] },
          { name: 'month', label: 'Month', type: 'month', value: prev, size: 'narrow' },
        ],
        'Show',
      ),
    ),
  );
  const org = params.get('org');
  if (!org) {
    main.append(emptyState('Choose an organisation and a month', 'From the 3rd of each month, last month’s statement can be issued.'));
    return;
  }
  const month = params.get('month') || prev;
  const base = `/api/statements/${enc(org)}/${enc(month)}`;
  const d = await api('GET', base);
  if (d.statement) {
    main.append(
      statementBlock(d.statement, d.view),
      h('p', { class: 'row' }, h('a', { href: `${base}.csv`, download: true }, 'Download CSV'), h('a', { href: `${base}.pdf`, download: true }, 'Download PDF')),
    );
  } else {
    const b = d.blockers;
    const early = Date.now() < d.issuableFrom;
    const ready = !early && !b.pending && !b.missingRateDays.length;
    main.append(
      panel(
        `${month}: not issued yet`,
        { hint: 'A statement is frozen once issued: no change and no second statement.' },
        table(
          ['Before issuing', 'State'],
          [
            tr('The month is over (from the 3rd of the next month)', early ? h('span', {}, badge('Not yet', 'warning'), h('span', { class: 'sub' }, `from ${time(d.issuableFrom)}`)) : badge('Done', 'ok')),
            tr('Every relayed event is settled', b.pending ? h('span', {}, badge('Waiting', 'warning'), h('span', { class: 'sub' }, `${b.pending} event(s) left; settlement runs every 15 minutes`)) : badge('Done', 'ok')),
            tr('Every day has a NEAR/USD rate', b.missingRateDays.length ? h('span', {}, badge('Missing', 'bad'), h('span', { class: 'sub' }, b.missingRateDays.join(', ')), link(`/rates?month=${enc(month)}`, 'Set them on the Rates screen')) : badge('Done', 'ok')),
          ],
        ),
        ready ? actionButton('Issue statement', () => api('POST', `${base}/issue`, {}), `Issue the ${month} statement for ${org}? It is frozen once issued: no change, no second statement.`, false, { primary: true, large: true, done: `The ${month} statement is issued.` }) : unavailable('Issue statement', 'Available once every item above is done.'),
      ),
    );
  }
  const exportOut = h('div', { role: 'status' });
  const exportBtn = h(
    'button',
    {
      type: 'button',
      onclick: async () => {
        exportBtn.disabled = true;
        exportOut.replaceChildren(loading('Exporting…'));
        try {
          const out = await api('POST', `/api/exports/${enc(org)}/${enc(month)}`, d.statement ? { asOf: d.statement.asOf } : {});
          exportOut.replaceChildren(
            note('ok', `${out.rows} rows as of ${time(out.asOf)}`, h('p', {}, `Final gas ${units(out.finalGas, 12)} Tgas, ${near(out.finalTokens)} NEAR. SHA-256 `, h('code', {}, out.sha256)), h('p', {}, h('a', { href: `/api/exports/${enc(org)}/${enc(month)}/${enc(out.file)}`, download: true }, 'Download the export'), h('span', { class: 'muted' }, ' (kept 30 days)'))),
          );
        } catch (err) {
          exportOut.replaceChildren(errorBox(err));
        }
        exportBtn.disabled = false;
      },
    },
    'Export ledger CSV',
  );
  main.append(panel('Ledger export', { hint: d.statement ? 'As of the statement’s time, so its final gas sums to the statement’s Tgas and NEAR.' : 'As of now.' }, exportBtn, exportOut));
  const list = await api('GET', `/api/statements?org=${enc(org)}`);
  main.append(
    panel(
      'Statements of this organisation',
      {},
      table(
        ['Month', 'As of', 'CSV SHA-256', 'Issued', 'By'],
        list.statements.map((s) => tr(link(`/statements?org=${enc(org)}&month=${enc(s.month)}`, s.month), time(s.asOf), mono(s.csvSha256), time(s.issuedAt), s.issuedBy)),
        { empty: 'No statement issued yet.' },
      ),
    ),
  );
}

async function ratesPage(main) {
  const params = new URLSearchParams(location.search);
  const month = params.get('month') || thisMonth();
  main.append(pageHead('NEAR/USD rates', { subtitle: 'Fetched daily from CoinGecko (the price at 00:00 UTC). A month with a statement is frozen. Testnet usage is valued at the mainnet price.' }), panel('Month', {}, queryForm('/rates', [{ name: 'month', label: 'Month', type: 'month', value: month, size: 'narrow' }], 'Show')));
  const d = await api('GET', `/api/rates?month=${enc(month)}`);
  main.append(
    panel(
      `Rates for ${month}`,
      {},
      d.missing.length ? note('warn', 'Days without a rate', `${d.missing.join(', ')}. A statement can’t be issued until each has one: set it below.`) : h('p', {}, badge('Complete', 'ok'), ' Every past day of the month has a rate.'),
      table(['Day', { text: 'USD per NEAR', num: true }, 'Source', 'Entered by', 'Set at'], d.rates.map((r) => h('tr', {}, h('td', {}, r.day), h('td', { class: 'num' }, usd(r.usdMicros)), h('td', {}, r.source === 'override' ? badge('Set by hand', 'warning') : r.source), h('td', {}, r.enteredBy || h('span', { class: 'muted' }, 'fetched')), h('td', {}, time(r.fetchedAt)))), { empty: 'No rate yet this month.' }),
    ),
    panel(
      'Set a rate by hand',
      { hint: 'Audited: the old and new rate, who and why are kept with it. Refused once the month has a statement.' },
      form(
        [
          { name: 'day', type: 'date', label: 'Day', required: true, size: 'narrow' },
          { name: 'usd', label: 'USD per NEAR', placeholder: '2.345678', required: true, pattern: '\\d+(\\.\\d{1,6})?', size: 'narrow', help: 'Up to 6 decimal places.' },
          { name: 'reason', label: 'Why', placeholder: 'CoinGecko returned a stale price for this day', required: true, minlength: 10, maxlength: 500, help: '10 to 500 characters, kept with the rate.' },
        ],
        'Set rate',
        (v) => api('PUT', `/api/rates/${enc(v.day)}`, { usd: v.usd.trim(), reason: v.reason.trim() }),
        { confirm: (v) => `Set ${v.day} to ${v.usd.trim()} USD per NEAR? It replaces the fetched rate for that day.`, done: (v) => `The rate for ${v.day} is set.` },
      ),
    ),
    panel('Rates set by hand', {}, table(['At', 'Day', { text: 'USD', num: true }, 'Was', 'By', 'Why'], d.overrides.map((o) => tr(time(o.at), o.day, usd(o.usdMicros), o.previousUsdMicros ? `${usd(o.previousUsdMicros)} (${o.previousSource})` : '(none)', o.enteredBy, o.reason)), { empty: 'No rate of this month was set by hand.' })),
  );
}

// The monthly retention job (C13, D90): its runs with the rows per table, a warning until a run succeeds, the next
// run, what waits for a person, the manual issuer step and the recent erasures.
const RETENTION_LABELS = {
  uidsStripped: 'uids removed (events past 24 months)',
  appUsersExpired: 'app_users last seen 24 months ago',
  partitionsDropped: 'monthly partitions dropped (past 7 years)',
  settlementsDeleted: 'settlements (past 7 years)',
  identityTokensDeleted: 'identity token days (past 7 years)',
  emailCountsDeleted: 'email count days (past 7 years)',
  settlementAlertsDeleted: 'settlement alerts (past 7 years)',
  settlementTriesDeleted: 'settlement tries (past 7 years)',
  nonceChecksDeleted: 'nonce checks (400 days)',
  rejectionAlertsDeleted: 'rejection alerts (400 days)',
  scopeWatchDeleted: 'watcher rows (400 days)',
  retentionRunsDeleted: 'retention runs (60 months)',
  erasuresDeleted: 'erasure records (60 months)',
  deletedAppsPurged: 'deleted apps purged',
  appUsersPurged: 'app_users of deleted apps',
  directoryScopes: 'scopes left without apps',
  directoryUsers: 'wallet directory users',
  directoryWallets: 'wallet directory wallets',
  directoryIdentities: 'wallet directory identities',
  appChangesDeleted: 'app_changes (60 months)',
  guardedChangesDeleted: 'guarded_changes (60 months)',
  auditLogDeleted: 'console audit_log (60 months)',
  ownerGrantsDeleted: 'owner grants (60 months)',
};

function retentionRows(rows) {
  const items = Object.entries(rows || {})
    .filter(([k, v]) => k !== 'due' && k !== 'calls' && typeof v === 'number' && v > 0)
    .map(([k, v]) => h('li', {}, `${RETENTION_LABELS[k] || k}: ${v}`));
  return items.length ? h('ul', {}, items) : h('span', { class: 'muted' }, 'nothing due');
}

const RETENTION_STATE = {
  due: 'due now (the next 15-minute run starts it)',
  continuing: 'continuing (the last run ran out of its calls)',
  done: 'done for this month',
  not_yet: 'not due yet',
  running: 'a run is in progress',
  retry_later: 'the last run failed; it is retried an hour after the failure',
};
const RUN_STATUS = { ok: ['Complete', 'ok'], partial: ['Partial: continued', 'warning'], failed: ['Failed', 'bad'], running: ['Running', 'info'] };

async function retentionPage(main) {
  const d = await api('GET', '/api/retention');
  main.append(pageHead('Retention', { subtitle: 'The monthly job that deletes what is past its keep period: raw usage 24 months (then the uid is removed and the rows kept), settlement records 7 years, audit logs 5 years, the admin’s own state 400 days. It runs from the 1st at 01:00 UTC until one run of the month completes.' }));
  if (d.warning) main.append(note('warn', 'Check the job', d.warning));
  main.append(
    panel(
      `This month (${d.month})`,
      {},
      facts([
        ['State', h('span', {}, d.state === 'done' ? badge('Done', 'ok') : d.state === 'retry_later' ? badge('Failed', 'bad') : badge(d.state === 'not_yet' ? 'Not due' : 'In progress', d.state === 'not_yet' ? '' : 'warning'), ' ', RETENTION_STATE[d.state] || d.state)],
        ['Due at', time(d.dueAt)],
        ['Next run', `${time(d.nextRunAt)} (${relative(d.nextRunAt)})`],
      ]),
    ),
    panel(
      'Waiting for a person',
      {},
      d.due && (d.due.statements || d.due.rates || d.due.rateOverrides)
        ? note('warn', 'Past 7 years: review and delete by hand', `${d.due.statements} statement(s)${d.due.oldestStatement ? ` (oldest ${d.due.oldestStatement})` : ''}, ${d.due.rates} rate(s), ${d.due.rateOverrides} rate override(s). Statements, rates and their files are deleted by hand after review (docs/operations.md "Retention").`)
        : emptyState('Nothing waits for review', 'No statement or rate is past 7 years.'),
      h('h3', {}, 'Every month, after the job'),
      h('p', { class: 'hint' }, 'This job doesn’t clean the email issuer’s user directory (rows of apps deleted 30 days ago) or its staff audit (60 months): this console only reads the issuer. Run this after each month’s run (docs/operations.md "Retention"):'),
      commandBlock('admin <env> retention:issuer --remote'),
    ),
    panel(
      'Runs',
      {},
      table(
        ['Run', 'Month', 'Started', 'Finished', 'Result', { text: 'Calls', num: true }, 'Rows deleted', 'Error'],
        d.runs.map((r) => tr(`#${r.id}`, r.month, time(r.startedAt), time(r.finishedAt), badge(...(RUN_STATUS[r.status] || [r.status, ''])), String((r.rows && r.rows.calls) || 0), retentionRows(r.rows), r.error ? h('code', {}, r.error) : '')),
        { empty: 'The job hasn’t run yet.' },
      ),
    ),
    panel(
      'Erasures',
      { hint: 'Each `uid-erase` run: who ran it, under which ticket, in which scope, and how many rows each store lost. Never whom.' },
      table(['At', 'Ticket', 'Operator', 'Scope', 'Rows'], d.erasures.map((e) => tr(time(e.at), mono(e.ticket), e.operator, mono(e.scopeId), detailPairs(e.rows))), { empty: 'No erasure yet.' }),
    ),
  );
}

// ---- users (C8b, D275): the issuer's directory, the wallet directory, the chain ----

// The search and the last support reference live in memory only: never in the URL, history or storage (no address,
// sub or code in a URL; the server's routes are POST). An opened user is too (D410): its page is the fixed path
// USER_OPEN_PATH, and the history entry holds only an opaque number into `opened` (this page's memory), so back and
// forward move between the users opened in this tab, and a reload or a copied link opens nobody.
const usersState = { form: {}, result: null, kind: null, ticket: '', opened: new Map(), seq: 0 };
const USER_OPEN_PATH = '/users/open';
/** Users kept for back and forward in this tab (the oldest forgotten past it). */
const OPENED_MAX = 50;
/** Labels shared with the partner console's Users screen (apps/console/web/src/pages/Users.tsx). */
const KIND = { google: 'Google', email: 'Email', apple: 'Apple' };
const kindLabel = (k) => KIND[k] || k;
const chainLabel = (c) => (c === 'stellar' ? 'Stellar' : c === 'evm' ? 'EVM' : c);
/** The help text of every support-reference field (the same rule for the console's and the issuer's audits). */
const TICKET_HELP = 'Your ticket or case number, e.g. ZD-4127: letters, digits and . _ # : - only. It is recorded in the audit with your name.';
/** Opens one identity's page from memory: the fixed path, the identity never in the URL or history state. */
function openUser(provider, sub) {
  usersState.seq += 1;
  usersState.opened.set(usersState.seq, { provider, sub });
  for (const k of usersState.opened.keys()) if (usersState.opened.size > OPENED_MAX) usersState.opened.delete(k);
  go(USER_OPEN_PATH, { user: usersState.seq });
}
/** A link to one identity's page: its href is the fixed path; a click opens it from memory (`openUser`). */
const userLink = (provider, sub, text) =>
  h(
    'a',
    {
      href: USER_OPEN_PATH,
      onclick: (ev) => {
        ev.preventDefault();
        openUser(provider, sub);
      },
    },
    text,
  );
/** A Support ID as the search box takes it (`HANA-XXXX-XXXX`, any case): it goes to the Support ID lookup (D399). */
const supportIdQuery = (q) => /^hana[\s-]?[0-9a-z]{4}-?[0-9a-z]{4}$/iu.test(q.trim());
/** A full address (console-core isFullAddress): an exact search, which names one identity and so needs the ticket (D410). */
const fullAddress = (q) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(q.trim());
/** What the search box names that the wallet directory answers (AdminRpc.findUsers) instead of the issuer's directory. */
function walletQuery(q) {
  const s = q.trim();
  return /^G[A-Z2-7]{55}$/u.test(s) || /^0x[0-9a-fA-F]{40}$/u.test(s) || /^u1_[A-Za-z0-9_-]{22}$/u.test(s) || /^hu_[0-9a-z]{26}$/iu.test(s) || supportIdQuery(s);
}

const unverifiedBadge = () => h('span', { class: 'badge warning' }, 'UNVERIFIED claim');

function directoryRows(users, warning) {
  const claims = users.filter((u) => u.unverifiedClaim).length;
  return [
    claims ? note('warn', '', `${warning} (${claims} row${claims === 1 ? '' : 's'} below, listed last).`) : '',
    table(
      ['Email', 'Account', 'Verified', 'Google-hosted', { text: 'Apps', num: true }, 'Last seen', ''],
      users.map((u) =>
        tr(
          u.unverifiedClaim ? h('span', {}, u.email, ' ', unverifiedBadge()) : u.email,
          kindLabel(u.provider),
          u.emailVerified ? 'yes' : h('strong', { class: 'warn' }, 'no'),
          u.hosted === null ? '' : u.hosted ? 'yes' : 'no',
          String(u.appCount),
          when(u.lastSeenMs),
          userLink(u.provider, u.sub, 'Open'),
        ),
      ),
      { empty: 'Nobody matches. Try fewer characters, or another account kind.' },
    ),
  ];
}

function walletUserBlock(u) {
  return h(
    'div',
    { class: 'match' },
    facts([
      ['User ID', mono(u.userId)],
      ['Support ID', mono(u.supportId)],
      ['Internal id', mono(u.internalId)],
      ['Scope', mono(u.scopeId)],
      ['Organisation', mono(u.orgId || '')],
      ['Created', time(u.createdAt)],
      ['Last seen', when(u.lastSeenAt)],
    ]),
    // The Support ID and its activity: the lookup by User ID, the ticket carried over (in memory); staff press "Look up".
    h('p', {}, h('button', { type: 'button', onclick: () => openLookup(u.userId, usersState.ticket, false) }, 'Support ID lookup: activity, sessions, emails')),
    h('h3', {}, 'Sign-in identities'),
    table(
      ['Account', 'Sub', 'Role', 'Status', 'Effective', 'Observed'],
      u.identities.map((i) => tr(kindLabel(i.provider), i.sub ? userLink(i.provider, i.sub, i.sub) : h('span', { class: 'muted' }, 'seen on chain only'), i.role, i.status, i.effectiveAt ? time(i.effectiveAt) : '', time(i.observedAt))),
    ),
    h('h3', {}, 'Wallets'),
    table(
      ['Chain', 'Address', { text: 'Key index', num: true }, 'First seen', 'Last used'],
      u.wallets.map((w) => tr(chainLabel(w.chain), h('span', {}, h('code', {}, w.address), w.sharedWith ? h('span', { class: 'sub' }, h('span', { class: 'badge warning' }, `also listed by ${w.sharedWith} other user(s): not proof of ownership`)) : ''), String(w.keyIndex), time(w.firstSeenAt), time(w.lastUsedAt))),
      { empty: 'No wallet yet.' },
    ),
    ...userEventsBlock(u),
  );
}

async function usersPage(main) {
  const f = usersState.form;
  const results = h('div', { 'aria-live': 'polite' });
  const showResults = () => {
    const r = usersState.result;
    if (!r) return results.replaceChildren();
    if (usersState.kind === 'wallet') {
      results.replaceChildren(panel('Wallet directory', {}, r.users.length ? h('div', {}, r.users.map(walletUserBlock)) : emptyState('Nobody has this id or wallet', 'A Support ID resolves only for users who logged in since the wallet directory’s deploy.')));
      return undefined;
    }
    results.replaceChildren(panel(`Directory: ${r.users.length}${r.next ? '+' : ''} ${r.users.length === 1 ? 'person' : 'people'}`, {}, ...directoryRows(r.users, r.unverifiedWarning), r.next ? h('p', {}, h('button', { type: 'button', onclick: () => runSearch(r.next) }, 'Next page')) : ''));
    return undefined;
  };
  const runSearch = async (cursor) => {
    results.replaceChildren(loading('Searching…'));
    try {
      const q = (f.q || '').trim();
      // A Support ID goes to the lookup (activity, shares, emails; D399), run at once when a support reference is given.
      // The wallet directory alone stays a click away there ("Wallet directory only", `/api/users/find`).
      if (q && supportIdQuery(q)) {
        openLookup(q, (f.ticket || '').trim(), true);
        return;
      }
      const ticket = (f.ticket || '').trim();
      // The reference typed here is the one an opened user or the lookup is offered next (memory only).
      if (ticket) usersState.ticket = ticket;
      // A search that names one user (an id, a wallet, a sub or a full address) needs the support reference (D410).
      if (!ticket && ((q && (walletQuery(q) || fullAddress(q))) || (f.sub || '').trim())) {
        results.replaceChildren(note('warn', 'Add a support reference', 'A support reference is required to search by User ID, internal id, wallet, sub or a full address: it is recorded in the audit. Browsing (a part of an address, the account kind, an app, unverified claims) needs none.'));
        el.elements.ticket.focus();
        return;
      }
      if (q && walletQuery(q)) {
        usersState.kind = 'wallet';
        usersState.result = await api('POST', '/api/users/find', { query: q, ticket });
      } else {
        usersState.kind = 'directory';
        const body = { limit: 50 };
        if (q) body.q = q;
        for (const k of ['provider', 'appId', 'sub', 'ticket']) if (f[k] && f[k].trim()) body[k] = f[k].trim();
        if (f.unverifiedOnly) body.unverifiedOnly = true;
        if (cursor) body.cursor = cursor;
        usersState.result = await api('POST', '/api/users/search', body);
      }
      showResults();
    } catch (err) {
      results.replaceChildren(errorBox(err));
    }
  };
  const filtersOpen = !!(f.provider || f.appId || f.sub || f.unverifiedOnly);
  const el = h(
    'form',
    {
      class: 'form',
      role: 'search',
      onsubmit: async (ev) => {
        ev.preventDefault();
        for (const k of ['q', 'provider', 'appId', 'sub', 'ticket']) f[k] = el.elements[k].value;
        f.unverifiedOnly = el.elements.unverifiedOnly.checked;
        await runSearch(null);
      },
    },
    field({ name: 'q', type: 'search', label: 'Email, User ID, Support ID or wallet', optional: false, value: f.q || '', placeholder: 'farah@ or HANA-2750-G5HM', help: 'Part of an email (3+ characters) browses. A full email, User ID (u1_…), internal id (hu_…) or wallet finds one person. A Support ID opens the Support ID lookup.' }),
    field({ name: 'ticket', label: 'Support reference', optionalText: ' (to find one person)', value: f.ticket || '', placeholder: 'ZD-4127', help: TICKET_HELP }),
    h(
      'details',
      { class: 'more', open: filtersOpen },
      h('summary', {}, 'More filters'),
      h(
        'div',
        { class: 'form' },
        field({ name: 'provider', type: 'select', label: 'Account kind', optional: false, value: f.provider || '', options: ['', 'email', 'google'].map((p) => ({ value: p, label: p ? kindLabel(p) : 'Any account' })), size: 'narrow' }),
        field({ name: 'appId', label: 'App id', value: f.appId || '', placeholder: 'app_…' }),
        field({ name: 'sub', label: 'Sub (exact)', value: f.sub || '', help: 'Needs a support reference.' }),
        field({ name: 'unverifiedOnly', type: 'checkbox', label: 'Unverified Google claims only', value: !!f.unverifiedOnly }),
      ),
    ),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Search')),
  );
  main.append(
    pageHead('Users', { subtitle: 'Find a person by email, id or wallet, then open them to see their apps, wallets and on-chain accounts. Hana staff only: partners never see addresses.' }),
    panel('Search', { hint: 'Every search and every opened user is audited by the email issuer under your Access identity. Each staff member can read at most 500 people an hour and 2 000 a day; past that the reads stop and Hana security is emailed. There is no export: bulk reads stay with `admin <env> user:list --json`.' }, el),
    results,
  );
  showResults();
}

function standingBlock(s) {
  if (!s.ok) return h('div', { class: 'match' }, h('h3', {}, 'Scope ', mono(s.scopeId)), note('warn', '', s.reason === 'not_read' ? 'Not read: this page reads a limited number of scopes per opening.' : 'The chain didn’t answer: try opening the user again.'));
  const rows = [
    ['Status', s.status === 'pending' ? `pending: takes effect ${time(s.effectiveAtMs)}` : s.status],
    ['Path', h('code', {}, s.path)],
    ['Opened (has a wallet)', s.opened ? 'yes' : 'no'],
    ['Identity key', h('code', {}, s.identityKey)],
    ['Read at block', s.blockHeight === null ? 'unknown' : String(s.blockHeight)],
  ];
  if (s.root) rows.splice(2, 0, ['Account root', userLink(s.root.provider, s.root.sub, `${kindLabel(s.root.provider)} ${s.root.sub}`)]);
  const parts = [h('h3', {}, 'Scope ', mono(s.scopeId)), facts(rows)];
  if (s.account) {
    parts.push(
      h('p', {}, 'Account root: ', userLink(s.account.root.provider, s.account.root.sub, `${kindLabel(s.account.root.provider)} ${s.account.root.sub}`), ` (epoch ${s.account.epoch})`),
      table(['Member', 'Sub', 'Key', 'Active', 'Effective'], s.account.members.map((m) => tr(kindLabel(m.provider), m.sub ? userLink(m.provider, m.sub, m.sub) : h('span', { class: 'muted' }, 'unknown to the wallet directory'), h('code', {}, m.key), m.active ? 'yes' : 'no', m.effectiveAtMs ? time(m.effectiveAtMs) : ''))),
    );
  } else if (s.accountUnread) parts.push(note('warn', '', `In an account; its members: ${s.accountUnread === 'not_read' ? 'not read (this page’s call budget)' : 'chain unavailable'}`));
  return h('div', { class: 'match' }, parts);
}

function userDetail(main, d) {
  const u = d.user;
  if (d.warning) main.append(note('warn', '', d.warning));
  main.append(
    panel(
      'Directory',
      {},
      !u
        ? emptyState('No directory row', 'The issuer hasn’t seen this identity log in since the directory’s deploy, its app is on no issuer env, or a best-effort write was lost.')
        : [
            facts([
              ['Email', u.unverifiedClaim ? h('span', {}, u.email, ' ', unverifiedBadge()) : u.email],
              ['Account', kindLabel(u.provider)],
              ['Sub', h('code', {}, u.sub)],
              ['Verified', u.provider === 'email' ? 'yes (a sign-in code)' : u.emailVerified ? 'yes (Google)' : h('strong', { class: 'warn' }, 'NO: Google hasn’t verified this address; the account only claims it')],
              ['Google-hosted', u.hosted === null ? '' : u.hosted ? 'yes' : 'no'],
              ['First seen', time(u.firstSeenMs)],
              ['Last seen', when(u.lastSeenMs)],
            ]),
            h('p', { class: 'hint' }, 'Seen times are when the issuer saw the identity log in; writes are best effort, so a lost one leaves a gap.'),
          ],
    ),
    panel(
      'Apps',
      {},
      d.appNamesError ? note('warn', '', `App names unavailable: ${d.appNamesError}`) : '',
      table(['App', 'Organisation', 'Environment', 'Scope', 'First seen', 'Last seen'], d.apps.map((a) => tr(a.name ? named(`${a.name}${a.deletedAt ? ' (deleted)' : ''}`, a.appId) : named(h('span', { class: 'muted' }, 'unknown'), a.appId), mono(a.orgId || ''), a.environment ? envBadge(a.environment) : '', mono(a.scopeId), time(a.firstSeenMs), time(a.lastSeenMs))), { empty: 'No app has seen this identity.' }),
      d.appsTruncated ? h('p', { class: 'hint' }, 'Only the 200 most recent apps are listed.') : '',
    ),
  );
  const wallets = panel('Wallets and ids', {});
  if (d.walletUsers === null) wallets.append(note('error', 'Wallet directory unavailable', d.walletError || 'error'));
  else if (d.walletUsers.length === 0) wallets.append(emptyState('No wallet-directory user yet', 'A user appears at their next login.'));
  else wallets.append(...d.walletUsers.map(walletUserBlock));
  main.append(wallets, panel('On chain, per scope (read live)', {}, d.chain.length ? h('div', {}, d.chain.map(standingBlock)) : emptyState('No scope to read', '')));
}

async function userPage(main) {
  const st = history.state;
  const who = st && typeof st.user === 'number' ? usersState.opened.get(st.user) : undefined;
  if (!who) {
    // A reload, a copied link or a user forgotten past OPENED_MAX: the identity was never in the URL, so open it again.
    main.append(pageHead('No user open', { back: { href: '/users', text: 'Users' }, subtitle: 'An opened user lives in this tab’s memory only, never in the URL, so a reload or a copied link opens nobody. Search Users and open them again.' }), h('p', {}, link('/users', 'Search Users')));
    return;
  }
  const { provider, sub } = who;
  main.append(pageHead([`${kindLabel(provider)} `, h('code', {}, sub)], { back: { href: '/users', text: 'Back to the search' }, subtitle: 'Nothing about this person is read until you give a support reference.' }));
  const out = h('div', { 'aria-live': 'polite' });
  const el = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const ticket = el.elements.ticket.value.trim();
        usersState.ticket = ticket;
        out.replaceChildren(loading('Reading…'));
        try {
          const d = await api('POST', '/api/users/get', { provider, sub, ticket });
          out.replaceChildren();
          userDetail(out, d);
        } catch (err) {
          out.replaceChildren(errorBox(err));
        }
      },
    },
    h('label', { class: 'field', for: 'user-ticket' }, h('span', { class: 'label' }, 'Support reference'), h('input', { name: 'ticket', required: true, maxlength: 64, pattern: '[A-Za-z0-9._#:\\-]{1,64}', value: usersState.ticket, id: 'user-ticket', placeholder: 'ZD-4127', 'aria-describedby': 'user-ticket-help' }), h('span', { class: 'help', id: 'user-ticket-help' }, `Required to open a person. ${TICKET_HELP}`)),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Open')),
  );
  main.append(panel('Open this person', {}, el), out);
}

function directoryAuditBlock(main, params, dir) {
  main.append(h('div', { class: 'panel-head' }, h('h2', {}, 'User directory reads and issuer staff actions')));
  if (dir === null || dir === undefined) {
    main.append(emptyState('No email issuer in this environment', ''));
    return;
  }
  if (dir.error) {
    main.append(sourceError('The issuer’s audit', { code: dir.error }));
    return;
  }
  main.append(table(['When', 'Staff', 'Action', 'Ticket', 'Scope', 'Subject', 'Details'], dir.rows.map((r) => tr(h('span', {}, time(r.atMs), h('span', { class: 'sub' }, `#${r.id}`)), r.staff, DIR_ACTION[r.action] || r.action, mono(r.ticket || ''), mono(r.scopeId || ''), r.subject || '', r.detail === null ? '' : detailPairs(r.detail))), { empty: 'No read matches.' }));
  if (dir.next) {
    const next = new URLSearchParams(params);
    next.set('dirBefore', String(dir.next));
    main.append(h('p', {}, link(`/audit?${next}`, 'Older issuer rows')));
  }
}

// ---- Support ID lookup (C15; D394–D396, D399) ----

// The query, the ticket, the request IDs and the last answer live in memory only: never in the URL, history state or
// storage (POST /api/support/lookup; no code, id or address in a URL). Reached from the nav, from the Users search (a
// Support ID) and from a wallet-directory user's block (by User ID). Nothing is read until staff press "Look up" (or
// search Users for a Support ID with a support reference): every lookup is audited first in the console's audit
// (`support.lookup`), and each address it shows is read from the issuer's directory, audited there (`support_lookup`).
const supportState = { form: { query: '', ticket: '', requestIds: '', days: '30' }, result: null, askedIds: 0, wallet: null, run: false };
/** The support reference's rule (console-core SUPPORT_TICKET_RE), the same for the console's and the issuer's audits. */
const SUPPORT_TICKET_PATTERN = '[A-Za-z0-9._#:\\-]{1,64}';

/** Opens the lookup screen for `query` (the ticket carried over when known); runs it when `run` and there is a ticket. */
function openLookup(query, ticket, run) {
  supportState.form = { query: query || '', ticket: ticket || '', requestIds: '', days: '30' };
  supportState.result = null;
  supportState.wallet = null;
  supportState.run = !!(run && ticket);
  focusHeading = true;
  go('/support');
}

/** Why an identity's address isn't shown (apps/admin/src/support.ts SupportEmailMissing). */
const EMAIL_MISSING = {
  not_found: 'not in the directory (no login seen since its deploy, or an app on no issuer env)',
  not_read: 'not read (this lookup’s limit of identities)',
  no_directory: 'no directory for this account kind',
  directory_unavailable: 'directory unavailable',
  directory_refused: 'the directory refused your staff identity (config drift: see the log)',
  rate_limited: 'not read: your directory row budget is used up',
  failed: 'the directory read failed',
};
const emailKey = (provider, sub) => `${provider}\n${sub}`;

/** The identity's address cell: `key` its directoryKey (null without a sub), `e` the email join's row for it. */
function emailCell(key, e) {
  if (!key) return h('span', { class: 'muted' }, 'no sub: seen on chain only');
  if (!e) return h('span', { class: 'muted' }, 'not read');
  if (!e.found) return h('span', { class: 'muted' }, EMAIL_MISSING[e.reason] || e.reason);
  return e.unverifiedClaim ? h('span', {}, e.email, ' ', unverifiedBadge()) : e.email;
}

const outcomeBadge = (o) => (o === 'ok' ? badge('ok', 'info') : o === 'rejected' ? badge('rejected', 'warning') : badge(o, 'critical'));

function supportMatchBlock(m, k, n, activity, ledger, emails, days) {
  const u = m.user;
  const appName = new Map(m.apps.map((a) => [a.appId, a.name]));
  const appLabel = (id) => (id ? named(appName.get(id) || 'unknown app', id) : '');
  const parts = [
    facts([
      ['User ID', mono(u.userId)],
      ['Support ID', mono(u.supportId)],
      ['Internal id', mono(u.internalId)],
      ['Scope', mono(u.scopeId)],
      ['Organisation', mono(u.orgId || '')],
      ['Created', time(u.createdAt)],
      ['Last seen', when(u.lastSeenAt)],
    ]),
    h('h3', {}, 'Sign-in identities'),
    table(
      ['Account', 'Email (the issuer’s directory)', 'Sub', 'Role', 'Status', 'Effective', 'Observed'],
      u.identities.map((i) =>
        tr(
          kindLabel(i.provider),
          emailCell(i.directoryKey, i.directoryKey ? emails.get(emailKey(i.directoryKey.provider, i.directoryKey.sub)) : undefined),
          i.sub ? userLink(i.provider, i.sub, i.sub) : h('span', { class: 'muted' }, 'seen on chain only'),
          i.role,
          i.status,
          i.effectiveAt ? time(i.effectiveAt) : '',
          time(i.observedAt),
        ),
      ),
    ),
    h('h3', {}, 'Wallets'),
    table(
      ['Chain', 'Address', { text: 'Key index', num: true }, 'First seen', 'Last used'],
      u.wallets.map((w) => tr(chainLabel(w.chain), h('span', {}, h('code', {}, w.address), w.sharedWith ? h('span', { class: 'sub' }, h('span', { class: 'badge warning' }, `also listed by ${w.sharedWith} other user(s): not proof of ownership`)) : ''), String(w.keyIndex), time(w.firstSeenAt), time(w.lastUsedAt))),
      { empty: 'No wallet yet.' },
    ),
    ...userEventsBlock(u),
    h('h3', {}, 'Apps of the scope'),
    table(['App', 'Organisation', 'Environment', 'Persistence', 'Deleted'], m.apps.map((a) => tr(named(a.name, a.appId), mono(a.orgId), a.environment ? envBadge(a.environment) : 'unknown', a.persistence, a.deletedAt ? time(a.deletedAt) : ''))),
    h('h3', {}, 'Vault shares that haven’t expired'),
    h('p', { class: 'hint' }, 'A share keeps the wallet across reloads (persistence "session"). Live: not revoked, and before its idle and absolute limits.'),
    table(['App', { text: 'Key index', num: true }, 'Created', 'Idle until', 'Expires', 'Revoked', 'Live'], m.shares.map((x) => tr(appLabel(x.appId), String(x.keyIndex), time(x.createdAt), time(x.idleUntil), time(x.absExpiresAt), x.revokedAt ? time(x.revokedAt) : '', x.live ? badge('live', 'info') : 'no')), { empty: 'No live share.' }),
    h('h3', {}, `App changes (last ${days} days, at most 50)`),
    changesTable(m.changes),
    h('h3', {}, `Ledger events (ok logins, sessions and derives; last ${days} days, at most 400)`),
  ];
  if (!ledger.available || activity === null) parts.push(note('warn', '', `Not shown: ${ledger.available ? 'ledger unavailable' : ledger.reason}`));
  else {
    parts.push(
      table(
        ['At', 'Request ID', 'App', 'Endpoint', { text: 'Status', num: true }, { text: 'Latency ms', num: true }, 'Relayed', 'NEAR tx'],
        activity.map((a) => tr(time(a.at), h('code', {}, a.requestId), appLabel(a.appId), a.endpoint, String(a.status), String(a.latencyMs), a.relayed ? 'yes' : 'no', a.nearTx ? h('code', {}, a.nearTx) : '')),
        { empty: 'No ledger event in this window.' },
      ),
      h('p', { class: 'hint' }, 'Failures carry no user id in the ledger, by design: look them up by the request IDs the partner gives.'),
    );
  }
  return panel(n > 1 ? [`Match ${k + 1} of ${n}: `, h('code', {}, u.supportId), ' ', h('code', {}, u.userId)] : ['User ', h('code', {}, u.supportId), ' ', h('code', {}, u.userId)], {}, parts);
}

function supportResult(out, v, askedIds) {
  const emails = new Map((v.emails || []).map((e) => [emailKey(e.provider, e.sub), e]));
  const by = v.query.kind === 'supportId' ? 'Support ID' : v.query.kind === 'userId' ? 'User ID' : 'internal id';
  out.append(h('p', { class: 'hint' }, `Looked up by ${by}, since ${time(v.since)} (${v.days} days). Recorded in the audit under your Access identity.`));
  if (!v.ledger.available) out.append(note('warn', '', `Ledger unavailable: ${v.ledger.reason}. Ledger events and request-ID events are not shown; the directory part below is complete.`));
  if (v.emailsNote) out.append(note('warn', '', v.emailsNote));
  if (v.unverifiedWarning) out.append(note('warn', '', v.unverifiedWarning));
  if (v.truncated) out.append(note('warn', '', `Truncated: more users share this Support ID than are listed; only the ${v.matches.length} most recently seen are shown. Ask the partner for the User ID.`));
  if (v.matches.length === 0) out.append(emptyState('No user has this id', 'A Support ID resolves only for users who logged in since the wallet directory’s deploy, and an erased user is gone. Check the code with the partner.'));
  else if (v.matches.length > 1 || v.truncated) {
    out.append(
      panel(
        'Matches',
        {},
        note('info', '', `${v.matches.length}${v.truncated ? '+' : ''} users share this Support ID (40 bits collide rarely). Tell them apart by the app and the time the partner names.`),
        table(['#', 'User ID', 'Scope', 'Organisation', 'Apps', 'Last seen'], v.matches.map((m, k) => tr(String(k + 1), h('code', {}, m.user.userId), mono(m.user.scopeId), mono(m.user.orgId || ''), m.apps.map((a) => a.name).join(', '), time(m.user.lastSeenAt)))),
      ),
    );
  }
  v.matches.forEach((m, k) => out.append(supportMatchBlock(m, k, v.matches.length, v.activity[k], v.ledger, emails, v.days)));
  if (!askedIds) return;
  const reqs = panel('Request IDs', { hint: 'The events of the request IDs the partner gave, with their errors.' });
  out.append(reqs);
  if (v.requests === null) {
    reqs.append(note('warn', '', `Not shown: ${v.ledger.available ? 'ledger unavailable' : v.ledger.reason}`));
    return;
  }
  reqs.append(
    table(
      ['At', 'Request ID', 'Outcome', 'Code', { text: 'Status', num: true }, 'Endpoint', 'Organisation', 'App', 'Scope', { text: 'Latency ms', num: true }, 'Relayed', 'NEAR tx', 'This user'],
      v.requests.map((r) =>
        tr(
          time(r.at),
          h('code', {}, r.requestId),
          outcomeBadge(r.outcome),
          r.code ? h('code', {}, r.code) : '',
          String(r.status),
          r.endpoint,
          mono(r.orgId),
          mono(r.appId || ''),
          mono(r.scopeId),
          String(r.latencyMs),
          r.relayed ? 'yes' : 'no',
          r.nearTx ? h('code', {}, r.nearTx) : '',
          r.byMatch ? 'yes' : h('span', { class: 'muted' }, 'no user id on the event'),
        ),
      ),
      { empty: 'None of these request IDs has a ledger event.' },
    ),
  );
  if (v.requestsNotFound.length) reqs.append(note('warn', '', h('p', {}, 'No ledger event for: ', v.requestsNotFound.flatMap((id, k) => [k ? ', ' : '', h('code', {}, id)]), ' (an unknown id, a rejection before the gate recorded it, or usage capture off then).')));
}

async function supportPage(main) {
  const f = supportState.form;
  const out = h('div', { 'aria-live': 'polite' });
  const show = () => {
    out.replaceChildren();
    if (supportState.wallet) out.append(panel('Wallet directory only', {}, supportState.wallet.users.length ? h('div', {}, supportState.wallet.users.map(walletUserBlock)) : emptyState('No user has this id or wallet', '')));
    else if (supportState.result) supportResult(out, supportState.result, supportState.askedIds);
  };
  let el;
  const read = () => {
    for (const k of ['query', 'ticket', 'requestIds', 'days']) f[k] = el.elements[k].value;
  };
  const run = async () => {
    supportState.wallet = null;
    supportState.result = null;
    out.replaceChildren(loading('Looking up…'));
    try {
      const body = { query: f.query.trim(), ticket: f.ticket.trim() };
      const ids = lines(f.requestIds);
      if (ids.length) body.requestIds = ids;
      if (String(f.days).trim() && Number(f.days) !== 30) body.days = Number(f.days);
      supportState.askedIds = ids.length;
      supportState.result = await api('POST', '/api/support/lookup', body);
      show();
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  };
  const walletOnly = async () => {
    read();
    supportState.result = null;
    out.replaceChildren(loading('Searching…'));
    try {
      supportState.wallet = await api('POST', '/api/users/find', { query: f.query.trim(), ticket: f.ticket.trim() });
      show();
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  };
  const label = (text, input, help, opts = {}) => {
    const id = `support-${input.getAttribute('name')}`;
    input.setAttribute('id', id);
    if (help) input.setAttribute('aria-describedby', `${id}-help`);
    return h('label', { class: `field${opts.size ? ` ${opts.size}` : ''}`, for: id }, h('span', { class: 'label' }, text, opts.optional ? h('span', { class: 'req' }, ' (optional)') : ''), input, help ? h('span', { class: 'help', id: `${id}-help` }, help) : '');
  };
  el = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        read();
        await run();
      },
    },
    label('Support ID, User ID or internal id', h('input', { name: 'query', required: true, maxlength: 64, placeholder: 'HANA-XXXX-XXXX, u1_… or hu_…', value: f.query, autocomplete: 'off' }), 'From the partner’s escalation. For a wallet address or a sub, search Users first.'),
    label('Support reference', h('input', { name: 'ticket', required: true, maxlength: 64, pattern: SUPPORT_TICKET_PATTERN, value: f.ticket, placeholder: 'ZD-4127', autocomplete: 'off' }), `${TICKET_HELP} The lookup is recorded before anything is read.`),
    label('Days back', h('input', { name: 'days', type: 'number', min: 1, max: 731, value: f.days }), '1 to 731.', { size: 'narrow' }),
    label('Request IDs from the escalation', h('textarea', { name: 'requestIds', placeholder: 'req_… one per line' }, f.requestIds), 'Up to 20, one per line. They come from the SDK’s errors and the demo’s diagnostics.', { size: 'wide', optional: true }),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Look up'), h('button', { type: 'button', onclick: walletOnly }, 'Wallet directory only'), h('span', { class: 'hint' }, 'Wallet directory only: ids and wallets, no activity. The reference is still recorded.')),
  );
  main.append(
    pageHead('Support ID lookup', { subtitle: 'What happened to one user: their ids, sign-ins with the directory’s emails, wallets, live sessions, the scope’s app changes, their ledger events, and the events of the request IDs a partner escalates (errors included).' }),
    panel('Look up a user', { hint: 'Hana staff only. Every lookup is audited before anything is read; each email is read from the issuer’s directory under your Access identity and row budget. There is no export: the operator’s path is the CLI’s `admin <env> support:lookup`.' }, el),
    out,
  );
  show();
  if (supportState.run) {
    supportState.run = false;
    await run();
  }
}

// ---- router ----

let me = null;

/** Moves to `path` (no data in it) and renders it; `state` is at most an opaque number (openUser), never data. */
function go(path, state = null) {
  history.pushState(state, '', path);
  render();
}

/** The tab "Sign in again" and "Renew" open: Access signed the staff member in to reach it; the work is in the other tab. */
async function signedInPage(main) {
  main.append(
    pageHead('You’re signed in', { subtitle: 'Go back to the tab you were working in and press Try again there: what you typed is still in that tab, and nothing was sent while you were signed out. You can close this tab.' }),
    h('p', {}, link('/orgs', 'Organisations')),
  );
}

async function notFoundPage(main) {
  main.append(pageHead('Page not found', { subtitle: 'This address isn’t a page of the admin console. Use the menu, or go to the organisations.' }), h('p', {}, link('/orgs', 'Organisations')));
}

/** Each render gets a number: an older render that finishes late doesn't replace a newer page. */
let renderSeq = 0;

async function render() {
  const seq = (renderSeq += 1);
  // The status page's "checked N s ago" ticker belongs to that page only.
  stopStatusTicker();
  renderNav();
  const root = document.getElementById('app');
  // The page is built off-screen in `main`, then swapped in whole (no half-drawn page, no flicker of an old one).
  const main = h('div', { class: 'view' });
  const shown = setTimeout(() => {
    if (seq === renderSeq && !root.contains(main)) root.replaceChildren(loading());
  }, 150);
  const path = location.pathname;
  session.dropOtherPages(path);
  try {
    if (!me) {
      me = await api('GET', '/api/me');
      noteExp(me);
      renderSession();
      document.getElementById('who').textContent = `Signed in as ${me.email}`;
      document.getElementById('env').textContent = me.env;
      document.title = `Hana ID admin (${me.env})`;
    }
    let m;
    if (path === '/' || path === '/status') await statusPage(main);
    else if (path === '/orgs') await orgsPage(main);
    else if ((m = /^\/orgs\/([^/]+)\/apps\/([^/]+)$/u.exec(path))) await appPage(main, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    else if ((m = /^\/orgs\/([^/]+)$/u.exec(path))) await orgPage(main, decodeURIComponent(m[1]));
    else if (path === '/audit') await auditPage(main);
    else if (path === '/security') await securityPage(main);
    else if (path === '/security/monitoring') await monitoringPage(main);
    else if (path === '/security/upgrades') await upgradesPage(main);
    else if (path === '/security/playbooks') await playbooksPage(main);
    else if ((m = /^\/security\/playbooks\/([a-z0-9-]{1,64})$/u.exec(path))) await playbookPage(main, m[1]);
    else if (path === '/reports') await reportsPage(main);
    else if (path === '/statements') await statementsPage(main);
    else if (path === '/rates') await ratesPage(main);
    else if (path === '/retention') await retentionPage(main);
    else if (path === '/users') await usersPage(main);
    else if (path === '/support') await supportPage(main);
    else if (path === USER_OPEN_PATH) await userPage(main);
    else if (path === SIGNED_IN_PATH) await signedInPage(main);
    else if (/^\/users\/(email|google)\//u.test(path)) {
      // The old detail path held the sub (before D410): this entry is rewritten to the search, and nothing is read.
      history.replaceState(null, '', '/users');
      renderNav();
      await usersPage(main);
    }
    else await notFoundPage(main);
  } catch (err) {
    main.append(errorBox(err));
  }
  clearTimeout(shown);
  if (seq !== renderSeq) return;
  const message = flash;
  flash = null;
  root.replaceChildren(...(message ? [note('ok', '', message)] : []), main);
  if (message) root.firstChild.setAttribute('role', 'status');
  if (focusHeading) {
    focusHeading = false;
    try {
      window.scrollTo(0, 0);
    } catch {
      // Not every browser (or test window) scrolls.
    }
    const heading = root.querySelector('h1');
    if (heading) heading.focus();
  }
}

render();
