// `GET {authOrigin}/login` (docs/batch-b-spec.md "Login" steps 3–5): the login popup. It finds whoever prepared the
// login (the vault, or the export window), authenticates its reply by origin and window, checks it against the pinned
// SIGNER, recomputes the nonce, stores the relayKey under the state in its own sessionStorage and navigates to Google.
// It never sees a token: /login/callback relays Google's answer. When the vault offers email too (build plan batch 8a;
// `methods` in auth-params, sent only when the app's `loginMethods` include email), it shows a method chooser instead:
// "Continue with Google" goes to Google as above, "Continue with email" stores the email context (email-storage.ts)
// and navigates this window to /login/email, which runs the code step and relays the email token through the same
// slot. A preselected `method` (`hana.login({method})`) skips the chooser. It makes no API call (D77): the app's facts it shows
// and uses (name, parent origin, scope, Google client) are the authenticated preparer's, which read them from the API
// itself, and the API checks them again on POST /v1/login before anything is relayed (docs/security.md "The login
// popup trusts the vault's app facts").
//
// Opener modes:
//   partner  /login?v=<vault frame name>  opened by the partner page; the vault is window.opener.frames[v]
//   vault    /login?from=vault            opened by the vault's launcher; the vault is window.opener
//   export   /login?mode=export           opened by the export window (authOrigin); it is window.opener
//
// SECURITY: auth-params carries relayKey, the one session secret that crosses postMessage. It is accepted only from
// the authenticated sender, kept only in sessionStorage, and the in-memory copy is zeroed.
import { type LoginMethod, type WindowMessage, isTestPublishableKey, parseWindowMessage, sessionNonce } from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import { type Dom, dom, errorView } from './dom.ts';
import { PageError } from './errors.ts';
import { type EmailContext, storeEmailContext } from './email-storage.ts';
import { GOOGLE_EMAIL_FLOW, type GoogleEmailFlow, loginGoogleRequest } from './google.ts';
import { addLoginTimings, storeLoginEntry } from './login-storage.ts';
import { appLogo } from './logo.ts';
import { type PageWindow, VAULT_FRAME_NAME, childFrame, fromPartnerVault, isFramed } from './page-window.ts';
import { vaultSignals } from './vault-signal.ts';

export type OpenerMode = 'partner' | 'vault' | 'export';

export { VAULT_FRAME_NAME };
export const HELLO_INTERVAL_MS = 100;
export const HELLO_TIMEOUT_MS = 15_000;
export const EXPORT_PATH = '/export';
/** The email step (auth/email-page.ts), reached by navigating this window; the fragment names the login (`#<relayId>`). */
export const EMAIL_PATH = '/login/email';

export interface LoginPageDeps {
  win: PageWindow;
  env: HanaEnv;
  /** Device clock (only for sessionStorage entry ages). */
  now?: () => number;
  /** Monotonic ms for a pk_test_ app's `authCheck` timing; defaults to performance.now. */
  perfNow?: () => number;
  /** How a login asks Google for the email scope (auth/google.ts GOOGLE_EMAIL_FLOW; tests run every flow). */
  googleEmailFlow?: GoogleEmailFlow;
}

export type LoginPageState =
  | { readonly stage: 'connecting'; readonly mode: OpenerMode }
  | { readonly stage: 'checking'; readonly mode: OpenerMode }
  /** The method chooser is shown (an app with email); a click moves on to `redirecting`. */
  | { readonly stage: 'choosing'; readonly mode: OpenerMode }
  | { readonly stage: 'redirecting'; readonly mode: OpenerMode; readonly url: string }
  | { readonly stage: 'error'; readonly code: string };

export interface LoginPage {
  readonly state: LoginPageState;
  /** Resolves when the page reached `choosing`, `redirecting` or `error`. */
  readonly done: Promise<LoginPageState>;
  stop(): void;
}

/** The opener mode from the query, or null when the link is not one of the three forms exactly. */
export function openerMode(search: string): { mode: OpenerMode; vaultFrame?: string } | null {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  if (keys.length !== 1) return null;
  const values = q.getAll(keys[0] as string);
  if (values.length !== 1) return null;
  const value = values[0] as string;
  if (keys[0] === 'v' && VAULT_FRAME_NAME.test(value)) return { mode: 'partner', vaultFrame: value };
  if (keys[0] === 'from' && value === 'vault') return { mode: 'vault' };
  if (keys[0] === 'mode' && value === 'export') return { mode: 'export' };
  return null;
}

/** `window.opener.location.pathname` when the opener is same-origin, else null (a cross-origin read throws). */
function openerPath(opener: Window): string | null {
  try {
    return opener.location.pathname;
  } catch {
    return null;
  }
}

export function startLoginPage(deps: LoginPageDeps): LoginPage {
  const { win, env } = deps;
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  const d: Dom = dom(win.document);
  let state: LoginPageState = { stage: 'error', code: 'config_mismatch' };
  let finish: (s: LoginPageState) => void = () => {};
  const done = new Promise<LoginPageState>((resolve) => {
    finish = resolve;
  });
  let helloTimer: ReturnType<typeof setInterval> | undefined;
  let helloDeadline: ReturnType<typeof setTimeout> | undefined;
  let accepted = false;

  const stop = () => {
    clearInterval(helloTimer);
    clearTimeout(helloDeadline);
    win.removeEventListener('message', onMessage);
  };
  const fail = (code: string | number, title: string, message: string) => {
    stop();
    state = { stage: 'error', code: String(code) };
    d.show(errorView(d, title, message, String(code)));
    finish(state);
  };

  const parsed = openerMode(win.location.search);
  const opener = win.opener;
  // D347's signals: to the vault frame (partner mode) or the vault's window (vault mode). The export window's child
  // has no vault to tell (its opener is the export window, on authOrigin).
  const signals = vaultSignals(win, () => (!parsed || !opener || parsed.mode === 'export' ? [] : [parsed.mode === 'partner' ? childFrame(opener, parsed.vaultFrame as string) : opener]), env.vaultOrigin);

  function onMessage(event: Event): void {
    if (accepted || !parsed || !opener) return;
    const e = event as MessageEvent;
    const msg = parseWindowMessage(e.data, ['hana:auth-params']);
    if (!msg) return;
    if (!fromPreparer(e, parsed.mode, parsed.vaultFrame)) return;
    accepted = true;
    stop();
    void check(msg, parsed.mode);
  }

  /** Step 4's sender check for the opener mode. */
  function fromPreparer(e: MessageEvent, mode: OpenerMode, vaultFrame?: string): boolean {
    if (!opener) return false;
    if (mode === 'export') return e.origin === env.authOrigin && e.source === opener && openerPath(opener) === EXPORT_PATH;
    if (mode === 'vault') return e.origin === env.vaultOrigin && e.source === opener;
    return fromPartnerVault(e, opener, vaultFrame as string, env.vaultOrigin);
  }

  async function check(msg: WindowMessage<'hana:auth-params'>, mode: OpenerMode): Promise<void> {
    const checkStarted = perfNow();
    state = { stage: 'checking', mode };
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Checking the sign-in request…')));
    try {
      // The preparer is Hana code on vaultOrigin (or this origin's /export), authenticated by event.origin and
      // event.source above; it read the app's scope and Google client from GET /v1/app and the registry. Only the
      // pinned SIGNER and the nonce's commitment are checked here: no second GET /v1/app (D77).
      if (msg.signer !== env.signer) throw new PageError('config_mismatch', 'The vault named another signer.');
      const nonce = sessionNonce({
        signer: env.signer,
        scopeId: msg.scopeId,
        sessionPublicKey: msg.sessionPublicKey,
        expiresAtMs: msg.expiresAtMs,
        keyIndex: msg.keyIndex,
        maxUses: msg.maxUses,
        salt: msg.salt,
      });
      if (nonce !== msg.nonce) throw new PageError('config_mismatch', 'The sign-in request’s nonce does not commit to its session.');
      // A link task (`hana.linkAccount`, batch 8b) signs in the new method with the vault's proof nonce instead.
      const task = mode !== 'export' && msg.task && msg.followKey ? msg.task : null;
      const follow = mode !== 'export' && msg.followKey ? msg.followKey : null;
      /** token_first's record-only login (D270): an app without email login, so no follow-up mode after Google. */
      const record = !!follow && !task && msg.emailRecord === true;
      const googleNonce = task?.prove.method === 'google' ? task.prove.nonce : msg.nonce;
      // The login's own Google request (auth/google.ts): token_first asks for the email access token first.
      const googleRequest = loginGoogleRequest({
        flow: deps.googleEmailFlow ?? GOOGLE_EMAIL_FLOW,
        clientId: msg.clientId,
        authOrigin: env.authOrigin,
        nonce: googleNonce,
        state: msg.relayId,
        follow: !!follow,
        task: !!task,
        forceReauth: mode === 'export',
      });
      // A record-only login under another flow (a popup built before the vault's switch) is batch B's openid login:
      // the callback then relays no access token, and the vault records nothing.
      try {
        // pk_test_ apps: this page's part of the vault's hello → token (its checks, the nonce, the entry), forwarded
        // by the callback inside the encrypted relay slot. A duration on this page's clock, nothing else.
        const timings = isTestPublishableKey(msg.pk) ? { authCheck: Math.max(0, perfNow() - checkStarted) } : undefined;
        storeLoginEntry(
          win.sessionStorage,
          msg.relayId,
          msg.relayKey,
          now(),
          timings,
          follow
            ? {
                followKey: follow,
                clientId: msg.clientId,
                ...(task ? { task: true } : {}),
                // token_first: the callback makes the ID token request after the access token, with this nonce.
                ...(googleRequest.tokenFirst ? { tokenFirst: true, nonce: googleNonce } : {}),
                ...(record ? { record: true } : {}),
              }
            : {},
        );
      } catch {
        throw new PageError('storage_unavailable', 'This browser blocked the storage the sign-in needs.');
      } finally {
        msg.relayKey.fill(0);
        msg.followKey?.fill(0);
      }
      const url = googleRequest.url;
      // The app's logo (batch C11), when the preparer sent one on this build's files origin.
      const intro = () =>
        d.h('p', {}, appLogo(d, env, msg.logoUrl), task ? 'Adding a sign-in method in ' : 'Signing in to ', d.h('strong', {}, msg.appName), ' at ', d.h('span', { class: 'origin' }, msg.parentOrigin));
      // Email is offered only by the vault or the export window, only for an env with an email issuer.
      const methods: readonly LoginMethod[] = msg.methods && env.emailIssuerUrl ? msg.methods : ['google'];
      /** The email context: the email step's facts, and (batch 8b) the follow-up mode's, which a Google login needs too. */
      const storeContext = (proof: EmailContext['proof'] = null): boolean => {
        try {
          storeEmailContext(
            win.sessionStorage,
            msg.relayId,
            {
              pk: msg.pk,
              appName: msg.appName,
              ...(msg.logoUrl ? { logoUrl: msg.logoUrl } : {}),
              parentOrigin: msg.parentOrigin,
              scopeId: msg.scopeId,
              sessionPublicKey: Uint8Array.from(msg.sessionPublicKey),
              expiresAtMs: msg.expiresAtMs,
              salt: Uint8Array.from(msg.salt),
              keyIndex: msg.keyIndex,
              maxUses: msg.maxUses,
              nonce: msg.nonce,
              clientId: methods.includes('google') ? msg.clientId : null,
              methods: [...methods],
              // D348: a login the partner restricted to one method comes back to that method only after a cancel.
              ...(msg.method && methods.includes(msg.method) ? { method: msg.method } : {}),
              emailHint: msg.emailHint ?? null,
              opener: mode === 'vault' ? 'vault' : 'partner',
              vaultFrame: parsed?.vaultFrame ?? null,
              challengeId: null,
              proof,
              exportMode: mode === 'export',
            },
            now(),
          );
          return true;
        } catch {
          fail('storage_unavailable', 'Sign-in stopped', 'This browser blocked the storage the sign-in needs.');
          return false;
        }
      };
      const toGoogle = (tell: boolean) => {
        // The follow-up mode's context, and (D341) the screen a cancel on token_first's Google screen goes back to: a
        // record-only login has no follow-up mode, but its cancel returns to a chooser with Google only.
        if (follow && !storeContext()) return;
        // In a login that offered email, the vault reports `google` only when the popup says so (hana:auth-progress).
        // D347: the popup says so before every navigation to Google, so the vault's close watch never takes it (or an
        // IdP's COOP switch on arrival) for a close; the export window's child has no vault to tell.
        // D400: it navigates once the vault acked (or after SIGNAL_ACK_WAIT_MS): Chromium drops the signal's source
        // when the navigation starts in the same task.
        if (tell || mode !== 'export') signals.post('google');
        d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, mode === 'export' ? 'Confirm it’s you' : 'Signing in'), intro(), d.h('p', { class: 'muted' }, 'Continuing to Google…')));
        state = { stage: 'redirecting', mode, url };
        void signals.leave(() => {
          finish(state);
          win.location.assign(url);
        });
      };
      const toEmail = (proof: EmailContext['proof'] = null) => {
        if (!storeContext(proof)) return;
        const target = `${EMAIL_PATH}#${msg.relayId}`;
        state = { stage: 'redirecting', mode, url: target };
        finish(state);
        win.location.assign(target);
      };
      if (task) {
        // `hana.linkAccount`: the new method's own sign-in, straight away (the SDK named it).
        if (task.prove.method === 'email') toEmail({ purpose: 'link_new', commitment: task.prove.commitment });
        else toGoogle(false);
        return;
      }
      if (!methods.includes('email') || msg.method === 'google') {
        // A preselected Google (`method: 'google'`): the vault reported `google` itself.
        toGoogle(false);
        return;
      }
      if (msg.method === 'email' || !methods.includes('google')) {
        toEmail();
        return;
      }
      // The chooser: two buttons, nothing fetched. The relay key entry is already stored for either path. A pk_test_
      // app's entry gets `choose` (chooser shown → click) added on the click.
      const chooserAt = perfNow();
      const chosen = () => addLoginTimings(win.sessionStorage, msg.relayId, { choose: Math.max(0, perfNow() - chooserAt) });
      const google = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'continue-google' } }, 'Continue with Google');
      const email = d.h('button', { attrs: { type: 'button', id: 'continue-email' } }, 'Continue with email');
      google.addEventListener('click', () => {
        google.setAttribute('disabled', '');
        email.setAttribute('disabled', '');
        chosen();
        toGoogle(true);
      });
      email.addEventListener('click', () => {
        google.setAttribute('disabled', '');
        email.setAttribute('disabled', '');
        chosen();
        toEmail();
      });
      d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Sign in'), intro(), d.h('div', { class: 'actions choose' }, google, email)));
      state = { stage: 'choosing', mode };
      finish(state);
    } catch (err) {
      msg.relayKey.fill(0);
      const e = err instanceof PageError ? err : new PageError('config_mismatch', 'The sign-in request could not be checked.');
      fail(e.code, 'Sign-in stopped', e.message);
    }
  }

  if (isFramed(win)) {
    fail('config_mismatch', 'Sign-in stopped', 'The Hana sign-in window can’t run inside another page.');
  } else if (!parsed) {
    fail('config_mismatch', 'Sign-in stopped', 'This sign-in link is not valid. Start again from the app.');
  } else if (opener === null) {
    fail(
      'coop_blocks_popup',
      'This site’s settings block the Hana sign-in window (COOP)',
      'The site you came from cut this window off from it, so the sign-in can’t finish here. Close this window and tell the site’s developers.',
    );
  } else {
    state = { stage: 'connecting', mode: parsed.mode };
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Connecting…')));
    win.addEventListener('message', onMessage);
    const targetOrigin = parsed.mode === 'export' ? env.authOrigin : env.vaultOrigin;
    const hello = () => {
      const target = parsed.mode === 'partner' ? childFrame(opener, parsed.vaultFrame as string) : opener;
      try {
        (target as Window | null)?.postMessage({ v: 1, t: 'hana:auth-hello' }, targetOrigin);
      } catch {
        // The opener navigated away or the frame is gone; keep trying until the deadline.
      }
    };
    hello();
    helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
    helloDeadline = setTimeout(() => {
      if (!accepted) fail('login_timeout', 'Sign-in stopped', 'The app’s Hana vault did not answer. Close this window and start again from the app.');
    }, HELLO_TIMEOUT_MS);
  }

  return {
    get state() {
      return state;
    },
    done,
    stop,
  };
}
