// `GET {authOrigin}/approve` (docs/batch-b-spec.md "Approval flow" and "Consent"): the approval popup. It talks only to
// the app's vault on vaultOrigin, decodes every request's bytes itself, and answers with a digest computed from
// exactly what it rendered (the approval digest, or the consent digest for the auto-approve consent screen), so the
// vault signs only what the user saw. Approve and Allow are guarded (approve-guard.ts). After an answer it waits up to
// 15 s for a follow-up request, then says bye and closes.
//
// Opener modes (D99):
//   vault    /approve                          opened by the vault's launcher; the vault is window.opener
//   partner  /approve?from=partner&v=<frame>   opened by the SDK on the partner page, in the user's click; the vault
//                                              is window.opener.frames[v], authenticated as the login popup does it:
//                                              event.origin === vaultOrigin, event.source === opener.frames[v], and
//                                              that frame's parent is the opener
// Either way it accepts requests and hana:approve-close only from that authenticated vault, never from the partner
// page that holds this window, and posts only to the vault (targetOrigin vaultOrigin). A partner-opened popup shows
// nothing for LOADING_DELAY_MS (an auto-approved or refused request closes it before that, so it barely flashes), and
// closes itself if no request arrives within ADOPT_TIMEOUT_MS.
//
// One request is on screen at a time. If the vault sends another (a different id) while one is still unanswered, the
// one on screen is rejected first (approve-result approved: false, or consent-result allowed: false, with its own
// digest), so the vault never waits on an id the user can no longer answer; the new one needs its own guarded Approve.
// The same id sent again (the vault re-sending what is on show) is rendered again, which also resets the guard.
//
// D411, D442: a request with `emailShared` shows "Email shared with {App} · Stop sharing" on the account line (the
// popup's account view, until Hana Home): the click posts `hana:email-revoke`, and the vault's `hana:email-revoked`
// says whether it worked. It changes nothing about the request on screen.
import {
  type ApprovalDigestInput,
  DecodeError,
  type WindowMessage,
  approvalDigest,
  consentDigest,
  parseWindowMessage,
} from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest } from '@hana-id/core/decode';
import { type AutoApprovePolicyV1, type AutoApproveReason, policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import type { HanaEnv } from '../hana-env.ts';
import { ApproveGuard, type GuardInput, guardInputOf } from './approve-guard.ts';
import { type Dom, dom, errorView } from './dom.ts';
import { appLogo } from './logo.ts';
import { type GestureCheck, type PageWindow, VAULT_FRAME_NAME, childFrame, fromPartnerVault, isFramed, isUserGesture } from './page-window.ts';
import { renderApproval } from './render-approval.ts';
import { renderConsent } from './render-consent.ts';
import { type BalanceFetch, readDemoBalance } from './demo-balance.ts';
import { type DemoNetwork, MAINNET_DEMO, assessMainnetDemo, demoNetworkOf, fixedMainnetDemoPrices, formatUsd, parseMainnetDemoPrices } from '@hana-id/core/mainnet-demo';

/** How long the popup waits for a follow-up request after an answer before it closes. */
export const KEEP_OPEN_MS = 15_000;
/** A partner-opened popup that no request reaches within this long says bye and closes (vault approvals.ts LATE_CLOSE_MS). */
export const ADOPT_TIMEOUT_MS = 8_000;
/** A partner-opened popup stays blank this long before it says it is loading, so an instant close barely shows. */
export const LOADING_DELAY_MS = 600;

export type ApproveOpenerMode = { mode: 'vault' } | { mode: 'partner'; vaultFrame: string };

/** The opener mode from the query: none (vault), or exactly `from=partner&v=<vault frame name>`; null otherwise. */
export function approveOpenerMode(search: string): ApproveOpenerMode | null {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  if (keys.length === 0) return { mode: 'vault' };
  if (keys.length !== 2 || q.getAll('from').length !== 1 || q.getAll('v').length !== 1) return null;
  const v = q.get('v') as string;
  return q.get('from') === 'partner' && VAULT_FRAME_NAME.test(v) ? { mode: 'partner', vaultFrame: v } : null;
}

/** Why the vault didn't auto-approve a request (the matcher's reason, policy/match.ts), in the popup's words. */
export const AUTO_APPROVE_REASON_TEXT: Readonly<Record<AutoApproveReason, string>> = Object.freeze({
  never_covered: 'this kind of request is never signed automatically',
  no_policy_section: 'the rules don’t cover this chain',
  decode_failed: 'Hana couldn’t fully read the request',
  network_not_listed: 'the network isn’t listed in the rules',
  chain_not_listed: 'the chain isn’t listed in the rules',
  fee_bump: 'fee-bump transactions are never signed automatically',
  unsupported_envelope: 'this transaction format isn’t supported',
  fee_too_high: 'the fee is over the rules’ limit',
  source_not_self: 'the transaction’s source isn’t your account',
  operation_not_allowed: 'it contains an operation the rules don’t allow',
  account_control: 'it changes who controls your account, which is never signed automatically',
  asset_not_listed: 'the asset isn’t listed in the rules',
  contract_creation: 'it creates a contract',
  contract_not_listed: 'the contract isn’t listed in the rules',
  function_not_listed: 'the function isn’t listed in the rules',
  selector_not_listed: 'the function isn’t listed in the rules',
  calldata_mismatch: 'the call doesn’t match the listed function',
  address_not_allowed: 'it involves an address the rules don’t allow',
  opaque_bytes: 'it carries data Hana can’t check',
  unsupported_argument: 'it has an argument Hana can’t check',
  decoder_unavailable: 'Hana can’t decode this protocol yet',
  decoder_refused: 'the protocol check refused it',
  typed_data_not_listed: 'this kind of signature isn’t listed in the rules',
  value_too_high: 'the amount is over the per-transaction limit',
  value_plus_fee_too_high: 'the amount plus the maximum network fee is over the per-transaction limit',
  daily_value_exceeded: 'it would go over today’s amount limit',
  daily_count_reached: 'today’s limit of automatic signatures is reached',
});

/**
 * Shown on every request and consent screen of a pk_test_ app (docs/decisions.md D39): its keys come from the testnet
 * MPC, so the vault refuses mainnet requests from it before they reach this popup.
 */
/** Beside the Support ID on the request screen (batch C15). */
export const SUPPORT_ID_HINT = 'Give this code to the app’s support if they ask; it doesn’t show your account or email.';
/** The account line's email sharing note (D442). */
export const EMAIL_SHARED_TEXT = {
  line: (app: string) => `Your email is shared with ${app}.`,
  stopped: (app: string) => `Stopped. ${app} no longer gets your email from Hana; it may keep the address it already received, so ask ${app} to delete it.`,
  failed: 'Hana couldn’t stop sharing. Try again.',
};
/** The mainnet demo's banner headline (D428): every approval of a request for Base or Stellar's public network. */
export const MAINNET_DEMO_BANNER = 'Real funds, test custody: these funds may be lost';
/** Under the headline: why (the keys come from the testnet MPC). */
export const MAINNET_DEMO_WHY = 'This test app signs on a real network with keys from Hana’s test infrastructure, which can be reset or broken. Use small amounts only.';

export const TEST_APP_NOTE = 'Test app: Hana ID signs only for test networks here. Requests for Stellar or EVM mainnets are refused, so don’t keep real funds at this account.';

/** The text for a reason code (an unknown code, from a newer vault, is shown generically). */
export function autoApproveReasonText(reason: string): string {
  return Object.hasOwn(AUTO_APPROVE_REASON_TEXT, reason) ? AUTO_APPROVE_REASON_TEXT[reason as AutoApproveReason] : 'it doesn’t match the rules';
}

export interface ApprovePageDeps {
  win: PageWindow;
  env: HanaEnv;
  now?: () => number;
  /** Whether a click is a real user gesture (event.isTrusted; tests inject one). */
  isGesture?: GestureCheck;
  /** The mainnet demo's balance reads (default: the browser's fetch); only Hana's pinned public endpoints. */
  fetch?: BalanceFetch;
}

type Current =
  | { readonly kind: 'request'; readonly msg: WindowMessage<'hana:approve-request'>; readonly input: ApprovalDigestInput; readonly decodable: boolean }
  | { readonly kind: 'consent'; readonly msg: WindowMessage<'hana:consent-request'>; readonly valid: boolean };

export type ApprovePageState = 'connecting' | 'request' | 'consent' | 'waiting' | 'closed' | 'error';

export interface ApprovePage {
  readonly state: ApprovePageState;
  readonly guard: ApproveGuard;
  stop(): void;
}

export function startApprovePage(deps: ApprovePageDeps): ApprovePage {
  const { win, env } = deps;
  const now = deps.now ?? (() => Date.now());
  const isGesture = deps.isGesture ?? isUserGesture;
  const balanceFetch: BalanceFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const d: Dom = dom(win.document);
  const opener = win.opener;
  const opened = approveOpenerMode(win.location.search);
  let state: ApprovePageState = 'connecting';
  let current: Current | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;
  let primary: HTMLButtonElement | null = null;
  let stopped = false;
  const visible = () => win.document.visibilityState !== 'hidden';
  const hasFocus = () => (typeof win.document.hasFocus === 'function' ? win.document.hasFocus() : true);
  const guard = new ApproveGuard(now, visible() && hasFocus() ? now() : null, (armed) => {
    if (primary) primary.disabled = !armed;
  });

  /** The vault window: the opener, or the partner page's vault frame (looked up each time, as the login popup does). */
  const vaultWindow = (): Window | null => {
    if (!opener || !opened) return null;
    return opened.mode === 'vault' ? opener : (childFrame(opener, opened.vaultFrame) as Window | null);
  };
  /** Only the authenticated vault: right origin and window for the opener mode. */
  const fromVault = (e: MessageEvent): boolean => {
    if (!opener || !opened) return false;
    if (opened.mode === 'vault') return e.origin === env.vaultOrigin && e.source === opener;
    return fromPartnerVault(e, opener, opened.vaultFrame, env.vaultOrigin);
  };

  const post = (m: Record<string, unknown>) => {
    try {
      vaultWindow()?.postMessage({ v: 1, ...m }, env.vaultOrigin);
    } catch {
      // The vault is gone (partner page closed or navigated); nothing to answer.
    }
  };

  const onGesture = (type: GuardInput['type']) => (e: Event) => {
    if (isGesture(e)) guard.gesture(guardInputOf(type, e));
  };
  const listeners: [string, (e: Event) => void][] = [
    ['message', onMessage],
    ['focus', () => guard.focused()],
    ['blur', () => guard.blurred()],
    ['pointermove', onGesture('pointermove')],
    ['pointerdown', onGesture('pointerdown')],
    ['keydown', onGesture('keydown')],
    ['pagehide', onPageHide],
  ];
  const onVisibility = () => (visible() ? guard.focused() : guard.blurred());

  function stop(): void {
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(loadingTimer);
    for (const [t, l] of listeners) win.removeEventListener(t, l);
    win.document.removeEventListener('visibilitychange', onVisibility);
  }

  function close(): void {
    if (state === 'closed') return;
    stop();
    state = 'closed';
    win.close();
  }

  function onMessage(event: Event): void {
    const e = event as MessageEvent;
    if (stopped || !fromVault(e)) return;
    const msg = parseWindowMessage(e.data, ['hana:approve-request', 'hana:consent-request', 'hana:approve-close', 'hana:email-revoked']);
    if (!msg) return;
    if (msg.t === 'hana:email-revoked') {
      onEmailRevoked(msg.ok);
      return;
    }
    if (msg.t === 'hana:approve-close') {
      // The vault ended what this window was for (auto-approved, refused, another window in use, logout). It already
      // settled anything on screen, so nothing is answered.
      close();
      return;
    }
    clearTimeout(idleTimer);
    clearTimeout(loadingTimer);
    if (msg.t === 'hana:approve-request') showRequest(msg);
    else showConsent(msg);
  }

  /** Closing the popup with something on screen answers it: Reject (the vault also maps a closed popup to 4001). */
  function onPageHide(): void {
    if (current) answer(false);
    stop();
  }

  function header(msg: { appName: string; parentOrigin: string; logoUrl?: string }, extra?: string): HTMLElement {
    return d.h(
      'header',
      { class: 'app' },
      // The app's logo (batch C11), when the vault sent one on this build's files origin.
      d.h('p', {}, appLogo(d, env, msg.logoUrl), extra ? `${extra} from ` : 'From ', d.h('strong', {}, msg.appName)),
      d.h('p', { class: 'origin' }, msg.parentOrigin),
    );
  }

  function buttons(primaryLabel: string, enabled: boolean): HTMLElement {
    const reject = d.h('button', { class: 'secondary', attrs: { type: 'button' } }, primaryLabel === 'Allow' ? 'Don’t allow' : 'Reject');
    reject.addEventListener('click', (e) => {
      if (isGesture(e)) answer(false);
    });
    const ok = d.h('button', { class: 'primary', attrs: { type: 'button' } }, primaryLabel);
    ok.disabled = true;
    // A keyboard click acts only once Approve has held focus for a moment (D113).
    ok.addEventListener('focus', () => guard.primaryFocused());
    ok.addEventListener('blur', () => guard.primaryBlurred());
    ok.addEventListener('click', (e) => {
      // The guard is checked here too, not only through `disabled`, and the click must have started (pointerdown, or
      // keydown for a keyboard click, whose detail is 0) after the gesture that armed it.
      if (isGesture(e) && enabled && guard.mayActivate((e as MouseEvent).detail === 0)) answer(true);
    });
    primary = enabled ? ok : null;
    return d.h('div', { class: 'actions' }, reject, enabled ? ok : null);
  }

  /** The user's Support ID (batch C15), as the vault sent it: the code an app's support may ask for. Text only. */
  function supportIdLine(supportId: string): HTMLElement {
    return d.h('p', { class: 'support-id muted' }, 'Support ID ', d.h('code', { class: 'mono' }, supportId), ` ${SUPPORT_ID_HINT}`);
  }

  /** The account line's "Stop sharing" (D411, D442): one revoke at a time; the vault's answer updates the line. */
  let emailBox: HTMLElement | null = null;
  function emailSharedLine(app: string): HTMLElement {
    const box = d.h('p', { class: 'email-shared muted', attrs: { id: 'email-shared' } }, EMAIL_SHARED_TEXT.line(app), ' ');
    const btn = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-stop' } }, 'Stop sharing');
    btn.addEventListener('click', (e) => {
      if (!isGesture(e) || btn.disabled) return;
      btn.disabled = true;
      post({ t: 'hana:email-revoke' });
    });
    box.append(btn);
    box.dataset.app = app;
    emailBox = box;
    return box;
  }

  function onEmailRevoked(ok: boolean): void {
    const box = emailBox;
    if (!box) return;
    const app = box.dataset.app ?? 'The app';
    if (ok) {
      box.replaceChildren(EMAIL_SHARED_TEXT.stopped(app));
      emailBox = null;
      return;
    }
    const btn = box.querySelector('button');
    if (btn) btn.disabled = false;
    box.setAttribute('data-failed', '1');
    box.firstChild?.replaceWith(`${EMAIL_SHARED_TEXT.failed} `);
  }

  function stopAutoApproveButton(label: string): HTMLElement {
    const box = d.h('div', { class: 'auto-approve' }, d.h('p', {}, 'Auto-approving under ', d.h('strong', {}, label), ' is on.'));
    const btn = d.h('button', { class: 'link', attrs: { type: 'button' } }, 'Stop auto-approving');
    btn.addEventListener('click', (e) => {
      if (!isGesture(e)) return;
      post({ t: 'hana:auto-approve-stop' });
      box.replaceChildren(d.h('p', {}, 'Auto-approving stopped. Every request will ask you again.'));
    });
    box.append(btn);
    return box;
  }

  /**
   * The mainnet demo's red banner (D428, D436): the request's value, from this popup's own decoding (never a number the
   * vault sends) at the vault's price book, once it passes the same checks here (the fixed table otherwise, the highest
   * value it could show), Hana's per-transaction limit, and the wallet's balance once read. A warning, never a block:
   * the vault has already refused anything over the limit.
   */
  function demoBanner(input: ApprovalDigestInput, network: DemoNetwork, id: string, demoPrices: unknown): HTMLElement {
    const cap = formatUsd(MAINNET_DEMO.txCapUsdMicros);
    const prices = parseMainnetDemoPrices(demoPrices, null) ?? fixedMainnetDemoPrices();
    const assessed = assessMainnetDemo(input, now(), prices);
    const value = assessed.ok
      ? `This request can move about ${formatUsd(assessed.usdMicros)}, fee included. Hana’s limit is ${cap} per transaction.`
      : `Hana’s limit is ${cap} per transaction.`;
    const balance = d.h('p', { class: 'muted demo-balance', attrs: { role: 'status' } }, 'Reading this wallet’s balance…');
    void readDemoBalance(network, input.address, balanceFetch, prices).then((b) => {
      if (current?.kind !== 'request' || current.msg.id !== id) return;
      if (b.kind === 'unknown') {
        balance.textContent = 'Balance unknown.';
        return;
      }
      const held = formatUsd(b.usdMicros);
      if (b.usdMicros > MAINNET_DEMO.balanceWarnUsdMicros) {
        balance.className = 'danger demo-balance';
        balance.textContent = `This wallet holds about ${held}: keep test funds under ${formatUsd(MAINNET_DEMO.balanceWarnUsdMicros)} — move the rest out.`;
      } else balance.textContent = `This wallet holds about ${held}.`;
    });
    return d.h(
      'div',
      { class: 'mainnet-demo', attrs: { role: 'alert' } },
      d.h('p', { class: 'danger takeover' }, MAINNET_DEMO_BANNER),
      d.h('p', { class: 'danger' }, value),
      d.h('p', { class: 'muted' }, MAINNET_DEMO_WHY),
      balance,
    );
  }

  /** A new request replaces the one on screen: the unanswered one is rejected first. */
  function replaceCurrent(id: string): void {
    if (current && current.msg.id !== id) post(result(current, false));
    current = null;
    primary = null;
  }

  function showRequest(msg: WindowMessage<'hana:approve-request'>): void {
    replaceCurrent(msg.id);
    const input: ApprovalDigestInput = {
      id: msg.id,
      kind: msg.kind,
      chain: msg.chain,
      address: msg.address,
      parentOrigin: msg.parentOrigin,
      context: msg.context,
      bytes: msg.bytes,
    };
    let decoded: DecodedApproval | null = null;
    let problem = '';
    try {
      decoded = decodeApprovalRequest(input);
    } catch (err) {
      problem = err instanceof DecodeError ? err.message : 'The request could not be read.';
    }
    current = { kind: 'request', msg, input, decodable: decoded !== null };
    state = 'request';
    const auto = msg.autoApprove;
    // A test app's request the popup itself reads as for a demo mainnet (the vault signs those only under the demo).
    const demo = msg.testApp && decoded ? demoNetworkOf(decoded) : null;
    d.show(
      d.h(
        'section',
        { class: 'panel approve' },
        header(msg, `Request ${msg.position} of ${msg.queued}`),
        d.h('p', { class: 'account' }, `Your ${msg.chain === 'stellar' ? 'Stellar' : 'EVM'} account `, d.h('code', { class: 'mono' }, msg.address)),
        msg.supportId ? supportIdLine(msg.supportId) : null,
        msg.emailShared ? emailSharedLine(msg.appName) : null,
        demo ? demoBanner(input, demo, msg.id, msg.demoPrices) : msg.testApp ? d.h('p', { class: 'note test-app' }, TEST_APP_NOTE) : null,
        auto?.reason ? d.h('p', { class: 'note' }, `Not signed automatically under “${auto.label}”: ${autoApproveReasonText(auto.reason)}.`) : null,
        decoded
          ? renderApproval(d, decoded, msg.appName)
          : d.h('div', { class: 'request' }, d.h('p', { class: 'danger' }, 'Hana can’t read this request, so it can’t be approved.'), d.h('p', { class: 'muted' }, problem)),
        buttons('Approve', decoded !== null),
        auto?.active ? stopAutoApproveButton(auto.label) : null,
      ),
    );
    guard.rendered();
  }

  function showConsent(msg: WindowMessage<'hana:consent-request'>): void {
    replaceCurrent(msg.id);
    // The popup validates the policy itself and recomputes its id: it shows and binds only a policy whose id is the
    // one the vault will store the consent under.
    let policy: AutoApprovePolicyV1 | null = null;
    const validated = validateAutoApprovePolicy(msg.policy);
    if (validated.ok) {
      try {
        policy = policyId(validated.policy) === msg.policyId ? validated.policy : null;
      } catch {
        policy = null;
      }
    }
    current = { kind: 'consent', msg, valid: policy !== null };
    state = 'consent';
    d.show(
      d.h(
        'section',
        { class: 'panel consent' },
        header(msg),
        msg.testApp ? d.h('p', { class: 'note test-app' }, TEST_APP_NOTE) : null,
        policy
          ? renderConsent(d, { policy, appName: msg.appName, parentOrigin: msg.parentOrigin, expiresAtMs: msg.expiresAtMs, nowMs: now() })
          : d.h('div', {}, d.h('h1', {}, 'Automatic signing'), d.h('p', { class: 'danger' }, 'This app’s automatic-signing rules could not be checked, so they can’t be allowed.')),
        buttons('Allow', policy !== null),
      ),
    );
    guard.rendered();
  }

  /** Closes after `ms` (KEEP_OPEN_MS) without a request, saying bye so the vault stops reusing this window. */
  function idleClose(ms = KEEP_OPEN_MS): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      post({ t: 'hana:approve-bye' });
      close();
    }, ms);
  }

  const loadingView = () => d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Review in Hana'), d.h('p', { class: 'muted' }, 'Loading the request…')));

  /** The answer to `c`, with the digest of exactly what was rendered for it. */
  function result(c: Current, approved: boolean): Record<string, unknown> {
    if (c.kind === 'request') return { t: 'hana:approve-result', id: c.msg.id, approved: approved && c.decodable, digest: approvalDigest(c.input) };
    const { id, policyId: pid, parentOrigin, expiresAtMs } = c.msg;
    return { t: 'hana:consent-result', id, allowed: approved && c.valid, digest: consentDigest({ id, policyId: pid, parentOrigin, expiresAtMs }) };
  }

  function answer(approved: boolean): void {
    const c = current;
    if (!c) return;
    current = null;
    primary = null;
    post(result(c, approved));
    guard.cleared();
    if (stopped) return;
    state = 'waiting';
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, approved ? 'Done' : 'Rejected'), d.h('p', { class: 'muted' }, `Waiting for the next request from ${c.msg.appName}…`)));
    idleClose();
  }

  if (isFramed(win)) {
    state = 'error';
    d.show(errorView(d, 'Hana', 'The Hana approval window can’t run inside another page.'));
  } else if (!opened) {
    state = 'error';
    d.show(errorView(d, 'Nothing to review', 'This approval link is not valid. Start again from the app.'));
  } else if (!opener) {
    state = 'error';
    d.show(errorView(d, 'Nothing to review', 'Open this window from the Hana prompt in the app.'));
  } else {
    for (const [t, l] of listeners) win.addEventListener(t, l);
    win.document.addEventListener('visibilitychange', onVisibility);
    if (opened.mode === 'vault') {
      loadingView();
      post({ t: 'hana:approve-hello' });
      idleClose();
    } else {
      // Blank at first: a request covered by the app's accepted policy (or refused) closes this window before it says
      // anything. Nothing on it can be approved until the vault sends a request.
      d.show(d.h('section', { class: 'panel', attrs: { 'aria-busy': 'true' } }));
      loadingTimer = setTimeout(loadingView, LOADING_DELAY_MS);
      post({ t: 'hana:approve-hello' });
      idleClose(ADOPT_TIMEOUT_MS);
    }
  }

  return {
    get state() {
      return state;
    },
    guard,
    stop,
  };
}
