// `GET {authOrigin}/approve` (docs/batch-b-spec.md "Approval flow" and "Consent"): the approval popup. It talks only to
// the app's vault on vaultOrigin, decodes every request's bytes itself, and answers with a digest computed from
// exactly what it rendered (the approval digest, or the consent digest for the auto-approve consent screen), so the
// vault signs only what the user saw. Approve and Allow are guarded (approve-guard.ts). After an answer it waits up to
// 15 s for a follow-up request, then says bye and closes; meanwhile it says what the answer did, counting down the time
// left, with Close now (D471).
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
import { type DecodedApproval, decodeApprovalRequest, shortId } from '@hana-id/core/decode';
import { type AutoApprovePolicyV1, type AutoApproveReason, policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { BRAND } from '@hana-id/brand';
import type { HanaEnv } from '../hana-env.ts';
import { ApproveGuard, GUARD_DELAY_MS, type GuardInput, guardInputOf } from './approve-guard.ts';
import { type Dom, dom, errorView, originText, row, rows } from './dom.ts';
import { GuardHint, coarsePointer } from './guard-hint.ts';
import { appLogo } from './logo.ts';
import { type GestureCheck, type PageWindow, VAULT_FRAME_NAME, childFrame, fromPartnerVault, isFramed, isUserGesture } from './page-window.ts';
import { fullId, renderApproval, watchOverflowing } from './render-approval.ts';
import { renderConsent } from './render-consent.ts';
import { BTN, alert, icon } from './ui.ts';
import { type BalanceFetch, readDemoBalance } from './demo-balance.ts';
import { type DemoBridge, type DemoNetwork, type DemoSwap, MAINNET_DEMO, assessMainnetDemo, demoNetworkOf, fixedMainnetDemoPrices, formatUsd, parseMainnetDemoPrices } from '@hana-id/core/mainnet-demo';

/** How long the popup waits for a follow-up request after an answer before it closes. */
/** The account line's chain names. */
const ACCOUNT_CHAIN_NAMES = { stellar: 'Stellar', evm: 'Ethereum-style', near: 'NEAR' } as const;

/**
 * The account line (D859): "Your account: 6e5e4e…f350 (NEAR)", the short form only, hidden from screen readers, which
 * read the whole account in the details' first row (where a sighted user finds it too).
 */
export const accountLine = (d: Dom, chain: keyof typeof ACCOUNT_CHAIN_NAMES, address: string): HTMLElement =>
  d.h('p', { class: 'account' }, 'Your account: ', d.h('code', { class: 'mono short-id', attrs: { 'aria-hidden': 'true' } }, shortId(address)), d.h('span', { class: 'sr-only' }, ` ${address}`), ` (${ACCOUNT_CHAIN_NAMES[chain]})`);

/**
 * The details' Copy for the user's own account (D876): the button, its name for screen readers, and what it says after
 * a press. The clipboard gets the account exactly (nothing secret: the account is public).
 */
export const COPY_ACCOUNT_TEXT = Object.freeze({
  button: 'Copy',
  name: 'Copy your account',
  copied: 'Copied',
  failed: 'Couldn’t copy. Select your account above and copy it yourself.',
});
/** How long "Copied" stays beside the button. */
export const COPIED_MS = 3000;

/** The Clipboard API's write, the only part of it this page uses. Never read. */
export interface ApproveClipboard {
  writeText(text: string): Promise<void>;
}

/** `navigator.clipboard` when this browser has the Clipboard API's write here, else null. */
function browserClipboard(): ApproveClipboard | null {
  try {
    const c = (globalThis as { navigator?: { clipboard?: Partial<ApproveClipboard> } }).navigator?.clipboard;
    return c && typeof c.writeText === 'function' ? (c as ApproveClipboard) : null;
  } catch {
    return null;
  }
}

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

/**
 * Why the vault didn't approve a request automatically (the matcher's reason code, policy/match.ts, unchanged), in plain
 * words (D853): one short reason after "Why: ".
 */
export const AUTO_APPROVE_REASON_TEXT: Readonly<Record<AutoApproveReason, string>> = Object.freeze({
  never_covered: 'this kind of request always needs your approval',
  no_policy_section: 'what you allowed doesn’t cover this network',
  decode_failed: `${BRAND.company} couldn’t fully read it`,
  network_not_listed: 'what you allowed doesn’t cover this network',
  chain_not_listed: 'what you allowed doesn’t cover this network',
  fee_bump: 'it pays the network fee for something else, which always needs your approval',
  unsupported_envelope: `${BRAND.company} can’t check this kind of request automatically`,
  fee_too_high: 'the network fee is higher than you allowed',
  source_not_self: 'it isn’t sent from your account',
  operation_not_allowed: 'it does something you didn’t allow',
  account_control: 'it changes who controls your account, which always needs your approval',
  asset_not_listed: 'it uses money or a token you didn’t allow',
  contract_creation: 'it creates a new program',
  contract_not_listed: 'it uses a program you didn’t allow',
  function_not_listed: 'it asks for an action you didn’t allow',
  selector_not_listed: 'it asks for an action you didn’t allow',
  calldata_mismatch: 'it doesn’t match the action you allowed',
  address_not_allowed: 'it involves an account you didn’t allow',
  opaque_bytes: `it carries information ${BRAND.company} can’t check`,
  unsupported_argument: `it has a detail ${BRAND.company} can’t check`,
  decoder_unavailable: `${BRAND.company} can’t check this app’s requests yet`,
  decoder_refused: `${BRAND.company}’s check refused it`,
  typed_data_not_listed: 'this kind of signature isn’t one you allowed',
  value_too_high: 'the amount is more than you allowed each time',
  value_plus_fee_too_high: 'the amount plus the network fee is more than you allowed each time',
  daily_value_exceeded: 'it would go over today’s amount limit',
  daily_count_reached: 'today’s limit of automatic approvals is reached',
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
  stopped: (app: string) => `Stopped. ${app} no longer gets your email from ${BRAND.company}; it may keep the address it already received, so ask ${app} to delete it.`,
  failed: `${BRAND.company} couldn’t stop sharing. Try again.`,
};
/** The mainnet demo's banner headline (D428): every approval of a request for Base or Stellar's public network. */
export const MAINNET_DEMO_BANNER = 'Real money, test system: you could lose it.';
/** Under the headline: why (the keys come from the testnet MPC). */
export const MAINNET_DEMO_WHY = `This test app uses real money with keys from ${BRAND.company}’s test system, which can be reset or broken. Use small amounts only.`;

// It claims no more than holds (review of PR 80): a test app's relayed NEAR approval could still run on the real
// network if the account exists there with the same key (D729's accepted residual), and the advice covers that case.
export const TEST_APP_NOTE = 'This app is a test version, so it works only with test money. Don’t keep real money in this account.';
/**
 * The same note for a test app with the mainnet demo on (D428), where the first one would be false: what the demo
 * signs, that it always asks, and that the custody is still test custody.
 */
export const TEST_APP_DEMO_NOTE = `This app is a test version with ${BRAND.company}’s real-money demo on. Besides test money, ${BRAND.product} approves real-money requests on Base and Stellar here, up to ${formatUsd(MAINNET_DEMO.txCapUsdMicros)} each. Those always ask you first and are never approved automatically. Other real networks are refused. The keys are test keys that can be reset or lost, so keep only small amounts in this account.`;
/** The out-of-policy note's first sentence after the app's name (D853): its automatic approvals didn't cover this one. */
export const OUT_OF_POLICY_TEXT = ' usually signs these without asking, but this one is outside what you allowed, so please check it yourself.';
/** The second line of the screen for a request this window can't read (D853), around the app's name: what to do. */
export const UNREADABLE_NEXT = ['Close this window and try again in ', '.'] as const;

/** The text for a reason code (an unknown code, from a newer vault, is shown generically). */
export function autoApproveReasonText(reason: string): string {
  return Object.hasOwn(AUTO_APPROVE_REASON_TEXT, reason) ? AUTO_APPROVE_REASON_TEXT[reason as AutoApproveReason] : 'it doesn’t match what you allowed';
}

export interface ApprovePageDeps {
  win: PageWindow;
  env: HanaEnv;
  now?: () => number;
  /** Whether a click is a real user gesture (event.isTrusted; tests inject one). */
  isGesture?: GestureCheck;
  /** The mainnet demo's balance reads (default: the browser's fetch); only Hana's pinned public endpoints. */
  fetch?: BalanceFetch;
  /** The request's renderer (tests inject one that fails). */
  render?: typeof renderApproval;
  /** The consent's renderer (tests inject one that fails). */
  renderConsentScreen?: typeof renderConsent;
  /** The clipboard the account's Copy writes to (default: `navigator.clipboard` when there is one; null: none). */
  clipboard?: ApproveClipboard | null;
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
  const renderRequest = deps.render ?? renderApproval;
  const renderPolicy = deps.renderConsentScreen ?? renderConsent;
  const clipboard = (): ApproveClipboard | null => (deps.clipboard === undefined ? browserClipboard() : deps.clipboard);
  const d: Dom = dom(win.document);
  const opener = win.opener;
  const opened = approveOpenerMode(win.location.search);
  let state: ApprovePageState = 'connecting';
  let current: Current | null = null;
  /** Stops watching the shown request's boxes for overflow (render-approval.ts watchOverflowing). */
  let stopWatching: (() => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setTimeout> | undefined;
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;
  let primary: HTMLButtonElement | null = null;
  let stopped = false;
  const visible = () => win.document.visibilityState !== 'hidden';
  const hasFocus = () => (typeof win.document.hasFocus === 'function' ? win.document.hasFocus() : true);
  const focusedAtStart = visible() && hasFocus() ? now() : null;
  // D878: the line under Approve (or Allow) while the guard holds it. Display only: told what the guard is told.
  const hint = new GuardHint({ d, now, focusedAtStart, coarse: coarsePointer(win as unknown as Parameters<typeof coarsePointer>[0]), id: 'guard-hint' });
  const guard = new ApproveGuard(now, focusedAtStart, (armed) => {
    if (primary) primary.disabled = !armed;
    hint.armed(armed);
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
    if (!isGesture(e)) return;
    const input = guardInputOf(type, e);
    guard.gesture(input);
    hint.input(input);
  };
  // The hint first, so its words follow the guard's state change that comes with each of these.
  const onFocus = () => {
    hint.focused();
    guard.focused();
  };
  const onBlur = () => {
    hint.blurred();
    guard.blurred();
  };
  const listeners: [string, (e: Event) => void][] = [
    ['message', onMessage],
    ['focus', onFocus],
    ['blur', onBlur],
    ['pointermove', onGesture('pointermove')],
    ['pointerdown', onGesture('pointerdown')],
    ['keydown', onGesture('keydown')],
    ['pagehide', onPageHide],
  ];
  const onVisibility = () => (visible() ? onFocus() : onBlur());

  function clearIdle(): void {
    clearTimeout(idleTimer);
    clearTimeout(countdownTimer);
  }

  function stop(): void {
    stopped = true;
    clearIdle();
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
    clearIdle();
    clearTimeout(loadingTimer);
    if (msg.t === 'hana:approve-request') showRequest(msg);
    else showConsent(msg);
  }

  /** Closing the popup with something on screen answers it: Reject (the vault also maps a closed popup to 4001). */
  function onPageHide(): void {
    if (current) answer(false);
    stop();
  }

  /** A test app's note: what the mainnet demo allows when the vault says it is on (a dev testnet build only). */
  function testAppNote(msg: { testApp?: true; mainnetDemo?: true }): HTMLElement | null {
    if (!msg.testApp) return null;
    const demoOn = msg.mainnetDemo === true && env.devEnv && env.network === 'testnet';
    return alert(d, 'info', { class: 'note test-app' }, demoOn ? TEST_APP_DEMO_NOTE : TEST_APP_NOTE);
  }

  function header(msg: { appName: string; parentOrigin: string; logoUrl?: string }, extra?: string): HTMLElement {
    return d.h(
      'header',
      { class: 'app' },
      // The app's logo (batch C11), when the vault sent one on this build's files origin. "Request 2 of 3 from" only
      // when more are waiting (D853); a single request reads "From {App}".
      d.h('p', {}, appLogo(d, env, msg.logoUrl), extra ? `${extra} from ` : 'From ', d.h('strong', {}, msg.appName)),
      originText(d, msg.parentOrigin, 'p'),
    );
  }

  /**
   * Reject and Approve (or Don't allow and Allow) for the request or consent `forId`. They answer only while that one
   * is on show: a button left on screen from an earlier request can never answer a newer one.
   */
  function buttons(primaryLabel: string, enabled: boolean, forId: string): HTMLElement {
    const onShow = () => current?.msg.id === forId;
    // The confirm pattern's decision row (D765): the one primary, the other secondary, side by side at 48 px.
    const reject = d.h('button', { class: 'secondary jp-btn jp-btn-secondary jp-btn-lg', attrs: { type: 'button' } }, primaryLabel === 'Allow' ? 'Don’t allow' : 'Reject');
    reject.addEventListener('click', (e) => {
      if (isGesture(e) && onShow()) answer(false);
    });
    const ok = d.h('button', { class: 'primary jp-btn jp-btn-primary jp-btn-lg', attrs: { type: 'button' } }, primaryLabel);
    ok.disabled = true;
    // A keyboard click acts only once Approve has held focus for a moment (D113).
    ok.addEventListener('focus', () => guard.primaryFocused());
    ok.addEventListener('blur', () => guard.primaryBlurred());
    ok.addEventListener('click', (e) => {
      // The guard is checked here too, not only through `disabled`, and the click must have started (pointerdown, or
      // keydown for a keyboard click, whose detail is 0) after the gesture that armed it.
      if (isGesture(e) && enabled && onShow() && guard.mayActivate((e as MouseEvent).detail === 0)) answer(true);
    });
    primary = enabled ? ok : null;
    if (enabled) hint.describe(ok, primaryLabel);
    const row = d.h('div', { class: 'actions decide' }, reject, enabled ? ok : null);
    // D878: right under the decision row, its space kept, so neither button moves when it appears or goes.
    return enabled ? d.h('div', { class: 'decide-group' }, row, hint.el) : row;
  }

  /**
   * The details' "Your account" row (D876): the whole account in one piece, then Copy. Copy only writes the account to
   * the clipboard and says so beside it; it is ordinary content for the Approve guard (a press of it is a gesture like
   * any other in the window, and it never answers anything). It sits in the folded details, at the start of the line,
   * away from the decision row, small and with its own words, so it can't be taken for Reject or Approve. "Copied" fits
   * beside it on the same line; only the refusal's sentence can take another line, and it stays until the next press.
   */
  function accountRow(address: string): HTMLElement {
    const status = d.h('span', { class: 'copy-status', attrs: { role: 'status' } });
    const btn = d.h('button', { class: `${BTN.secondary} jp-btn-sm copy-account`, attrs: { type: 'button', 'aria-label': COPY_ACCOUNT_TEXT.name } }, icon(d, 'copy'), COPY_ACCOUNT_TEXT.button);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const say = (text: string, fade: boolean) => {
      clearTimeout(timer);
      status.textContent = text;
      if (fade)
        timer = setTimeout(() => {
          if (status.textContent === text) status.textContent = '';
        }, COPIED_MS);
    };
    btn.addEventListener('click', (e) => {
      if (!isGesture(e)) return;
      const c = clipboard();
      if (!c) return say(COPY_ACCOUNT_TEXT.failed, false);
      let write: Promise<void>;
      try {
        write = c.writeText(address);
      } catch {
        return say(COPY_ACCOUNT_TEXT.failed, false);
      }
      write.then(
        () => say(COPY_ACCOUNT_TEXT.copied, true),
        () => say(COPY_ACCOUNT_TEXT.failed, false),
      );
    });
    return rows(d, [row(d, 'Your account', fullId(d, address), d.h('div', { class: 'copy-line' }, btn, status))], 'jp-kv facts your-account');
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
    // "Stop auto-approving" is Passport Home's word for the same stop (home-devices.ts): one word on both.
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
    // `shown`: this page holds the signing chain's address only, so it shows a bridge's or swap's recipient (the vault
    // has bound it to the user's own wallet before this popup opened), and the assessment still checks the hub wallet and
    // a swap's other fields against that address itself, so a recipient appears only once they are verified.
    const assessed = assessMainnetDemo(input, now(), prices, 'shown');
    const value = assessed.ok
      ? `This can move about ${formatUsd(assessed.usdMicros)}, fees included. ${BRAND.company}’s limit is ${cap} each time.`
      : `${BRAND.company}’s limit is ${cap} each time.`;
    const balance = d.h('p', { class: 'muted demo-balance', attrs: { role: 'status' } }, 'Reading this account’s balance…');
    void readDemoBalance(network, input.address, balanceFetch, prices).then((b) => {
      if (current?.kind !== 'request' || current.msg.id !== id) return;
      if (b.kind === 'unknown') {
        balance.textContent = 'Couldn’t read the balance.';
        return;
      }
      const held = formatUsd(b.usdMicros);
      if (b.usdMicros > MAINNET_DEMO.balanceWarnUsdMicros) {
        balance.className = 'danger demo-balance';
        balance.textContent = `This account holds about ${held}. Keep less than ${formatUsd(MAINNET_DEMO.balanceWarnUsdMicros)} here and move the rest out.`;
      } else balance.textContent = `This account holds about ${held}.`;
    });
    // One danger alert (the system's `.jp-alert-danger`): its icon, then the banner's lines.
    return alert(
      d,
      'danger',
      { tag: 'div', class: 'mainnet-demo', attrs: { role: 'alert' } },
      d.h('p', { class: 'danger takeover' }, MAINNET_DEMO_BANNER),
      d.h('p', { class: 'danger' }, value),
      assessed.ok && assessed.bridge ? bridgeLine(assessed.bridge) : null,
      assessed.ok && assessed.swap ? swapLine(assessed.swap) : null,
      assessed.ok && assessed.swap ? d.h('p', { class: 'demo-swap-minimum' }, `Minimum you receive: ${assessed.swap.minimumOutput} ${assessed.swap.outputSymbol}`) : null,
      d.h('p', { class: 'muted' }, MAINNET_DEMO_WHY),
      balance,
    );
  }

  /** What a Sodax bridge does (D476): the same amount arrives, on the other chain, at this recipient. */
  function bridgeLine(b: DemoBridge): HTMLElement {
    return d.h('p', { class: 'demo-bridge' }, `Moves ${b.amount} ${b.symbol} from ${b.fromChain} to ${b.toChain}. The same amount arrives. Receiver on ${b.toChain}: `, d.h('code', { class: 'mono' }, b.recipient));
  }

  /** Where a Sodax swap's output goes. */
  function swapLine(s: DemoSwap): HTMLElement {
    return d.h('p', { class: 'demo-swap' }, `Swaps on Sodax. Receiver on ${s.toChain}: `, d.h('code', { class: 'mono' }, s.recipient));
  }

  /** A new request replaces the one on screen: the unanswered one is rejected first. */
  function replaceCurrent(id: string): void {
    if (current && current.msg.id !== id) post(result(current, false));
    current = null;
    primary = null;
  }

  /**
   * The refusal for a request this window can't read or show: no Approve. The plain line, what to do, and the reason
   * (a developer's words) folded, for support (D853).
   */
  const unreadable = (problem: string, app: string, address?: string): HTMLElement[] => [
    alert(d, 'danger', { class: 'danger' }, `${BRAND.company} can’t read this request, so it can’t be approved.`),
    d.h('p', { class: 'unreadable-next' }, UNREADABLE_NEXT[0], d.h('strong', {}, app), UNREADABLE_NEXT[1]),
    d.h('details', { class: 'request-details unreadable-reason' }, d.h('summary', { class: 'details-toggle' }, 'Show details'), address ? accountRow(address) : null, d.h('p', { class: 'muted' }, 'Error (for support): ', d.h('code', { class: 'mono' }, problem))),
  ];

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
      // A sponsored action is checked against this build's own sponsor chains (its delegate and relayer) and the page's
      // clock (its deadline), never the vault's word.
      decoded = decodeApprovalRequest(input, { ...(env.evmSponsor ? { sponsorChains: env.evmSponsor } : {}), nowMs: now() });
    } catch (err) {
      problem = err instanceof DecodeError ? err.message : 'The request could not be read.';
    }
    const auto = msg.autoApprove;
    const supportId = msg.supportId ? supportIdLine(msg.supportId) : null;
    // The new screen is built off the page first. If anything in it fails, the window shows that this request can't be
    // approved, with no Approve button, rather than leaving the previous screen up (review N1). Only once a screen is
    // ready does `current` become the new request; until then nothing on screen answers anything (replaceCurrent).
    let screen: HTMLElement;
    let approvable = decoded !== null;
    try {
      // A test app's request the popup itself reads as for a demo mainnet (the vault signs those only under the demo).
      const demo = msg.testApp && decoded ? demoNetworkOf(decoded) : null;
      const notes = [
        demo ? demoBanner(input, demo, msg.id, msg.demoPrices) : testAppNote(msg),
        // The out-of-policy case (the confirm pattern's warning alert): why the app's rules didn't sign this one.
        auto?.reason ? alert(d, 'warning', { class: 'note out-of-policy' }, d.h('span', {}, d.h('strong', {}, msg.appName), OUT_OF_POLICY_TEXT), ' ', d.h('span', {}, `Why: ${autoApproveReasonText(auto.reason)}.`)) : null,
      ];
      screen = d.h(
        'section',
        { class: 'panel approve' },
        header(msg, msg.queued > 1 || msg.position > 1 ? `Request ${msg.position} of ${msg.queued}` : undefined),
        accountLine(d, msg.chain, msg.address),
        msg.emailShared ? emailSharedLine(msg.appName) : null,
        // D808: the plain summary first, then the warnings and these notes (never folded), then the details, where the
        // Support ID goes. An unreadable request keeps the Support ID and the notes in view.
        decoded
          ? renderRequest(d, decoded, msg.appName, { envNetwork: env.network, testApp: msg.testApp === true, parentOrigin: msg.parentOrigin, address: msg.address, notes, detailsExtra: [accountRow(msg.address), supportId], nowMs: now() })
          : d.h('div', { class: 'request' }, supportId, ...notes, ...unreadable(problem, msg.appName, msg.address)),
        buttons('Approve', decoded !== null, msg.id),
        auto?.active ? stopAutoApproveButton(auto.label) : null,
      );
    } catch {
      approvable = false;
      screen = d.h('section', { class: 'panel approve' }, d.h('div', { class: 'request' }, ...unreadable('The request could not be shown.', msg.appName)), buttons('Approve', false, msg.id));
    }
    current = { kind: 'request', msg, input, decodable: approvable };
    state = 'request';
    d.show(screen);
    hint.rendered(primary !== null);
    guard.rendered();
    // Boxes that hold more than they show say so, now that they are laid out, and again whenever their size changes.
    stopWatching?.();
    stopWatching = watchOverflowing(win.document, win as unknown as Parameters<typeof watchOverflowing>[1]);
  }

  const consentRefusal = (): HTMLElement => d.h('div', { class: 'consent' }, d.h('h1', {}, 'Automatic approvals'), alert(d, 'danger', { class: 'danger' }, `${BRAND.company} couldn’t check this app’s rules for automatic approvals, so they can’t be allowed.`));

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
    // Built off the page first, as a request is: a failure shows the refusal, never the previous screen (review N1).
    let screen: HTMLElement;
    let valid = policy !== null;
    try {
      screen = d.h(
        'section',
        { class: 'panel consent' },
        header(msg),
        testAppNote(msg),
        policy
          ? renderPolicy(d, { policy, appName: msg.appName, parentOrigin: msg.parentOrigin, expiresAtMs: msg.expiresAtMs, nowMs: now() })
          : consentRefusal(),
        buttons('Allow', policy !== null, msg.id),
      );
    } catch {
      valid = false;
      screen = d.h('section', { class: 'panel consent' }, consentRefusal(), buttons('Allow', false, msg.id));
    }
    current = { kind: 'consent', msg, valid };
    state = 'consent';
    d.show(screen);
    hint.rendered(primary !== null);
    guard.rendered();
  }

  /** Says bye, so the vault stops reusing this window, and closes it. */
  function byeAndClose(): void {
    if (state === 'closed') return;
    post({ t: 'hana:approve-bye' });
    close();
  }

  /**
   * Closes after `ms` (KEEP_OPEN_MS) without a request. `onSecond`, only where the screen shows a countdown, gets the
   * whole seconds left now and at each whole second after, all read from this one deadline, so a throttled background
   * timer can't make the number wrong. A new request or a close clears both timers (clearIdle).
   */
  function idleClose(ms = KEEP_OPEN_MS, onSecond?: (secondsLeft: number) => void): void {
    clearIdle();
    const deadline = now() + ms;
    idleTimer = setTimeout(byeAndClose, ms);
    if (!onSecond) return;
    const tick = () => {
      const left = deadline - now();
      if (left <= 0) return;
      onSecond(Math.ceil(left / 1000));
      countdownTimer = setTimeout(tick, left % 1000 || 1000);
    };
    tick();
  }

  const loadingView = () => d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Review request'), d.h('p', { class: 'muted' }, 'Loading the request…')));

  /** Whether `c` can be approved at all: a request the popup decoded, a policy it validated. */
  const answerable = (c: Current): boolean => (c.kind === 'request' ? c.decodable : c.valid);

  /** The answer to `c`, with the digest of exactly what was rendered for it. */
  function result(c: Current, approved: boolean): Record<string, unknown> {
    if (c.kind === 'request') return { t: 'hana:approve-result', id: c.msg.id, approved: approved && answerable(c), digest: approvalDigest(c.input) };
    const { id, policyId: pid, parentOrigin, expiresAtMs } = c.msg;
    return { t: 'hana:consent-result', id, allowed: approved && answerable(c), digest: consentDigest({ id, policyId: pid, parentOrigin, expiresAtMs }) };
  }

  /** A check mark in the system's success colours (css/approval.css), for an answer that went ahead. Decorative: the heading says it. */
  function checkMark(): SVGSVGElement {
    const SVG = 'http://www.w3.org/2000/svg';
    const el = (tag: string, attrs: Record<string, string>) => {
      const node = d.doc.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      return node;
    };
    const svg = el('svg', { class: 'outcome-mark', viewBox: '0 0 24 24', width: '26', height: '26', 'aria-hidden': 'true', focusable: 'false' }) as SVGSVGElement;
    svg.append(el('circle', { class: 'bg', cx: '12', cy: '12', r: '12' }), el('path', { class: 'tick', d: 'M7 12.5l3.4 3.4L17 9' }));
    return svg;
  }

  /**
   * The screen after an answer (D471): what it did, in words true for each kind (an approved request is not yet a sent
   * transaction; a consent signs nothing), the time left, Close now. `accepted` is the value the vault was sent. The
   * app's name goes in as a node, as everywhere on this page: text only, and bidi-isolated (`strong`).
   */
  function answeredView(c: Current, accepted: boolean, countdown: HTMLElement): HTMLElement {
    const consent = c.kind === 'consent';
    const heading = accepted ? (consent ? 'Allowed' : 'Approved') : consent ? 'Not allowed' : 'Rejected';
    const lines = accepted
      ? [d.h('p', {}, 'You can go back to ', d.h('strong', {}, c.msg.appName), '.'), d.h('p', { class: 'muted' }, 'If it needs another approval, it’ll appear here.')]
      : [d.h('p', {}, consent ? 'Automatic approvals weren’t turned on.' : 'Nothing was sent or approved.')];
    const closeNow = d.h('button', { class: 'secondary jp-btn jp-btn-secondary', attrs: { type: 'button', id: 'approve-close' } }, 'Close now');
    const shownAt = now();
    closeNow.addEventListener('click', (e) => {
      // The rest of a double-click on Approve or Reject, or taps carried over from that screen, must not close the
      // window and cost the follow-up: in a short or scrolled window this can sit where those buttons were. So the
      // same 1 s as D36, which is enough here (a press of Close now can't sign anything, so one tap does it), and the
      // page never focuses it, so a held Enter can't reach it.
      if (isGesture(e) && now() - shownAt >= GUARD_DELAY_MS) byeAndClose();
    });
    // The result is the live region; the countdown stays outside it, so it isn't announced every second.
    return d.h(
      'section',
      { class: 'panel answered' },
      d.h('div', { attrs: { role: 'status' } }, d.h('h1', { class: 'outcome' }, accepted ? checkMark() : null, heading), ...lines),
      d.h('div', { class: 'answered-foot' }, countdown, closeNow),
    );
  }

  function answer(approved: boolean): void {
    const c = current;
    if (!c) return;
    current = null;
    primary = null;
    post(result(c, approved));
    hint.cleared();
    guard.cleared();
    if (stopped) return;
    state = 'waiting';
    const countdown = d.h('p', { class: 'countdown muted' });
    d.show(answeredView(c, approved && answerable(c), countdown));
    idleClose(KEEP_OPEN_MS, (seconds) => {
      countdown.textContent = `Closing in ${seconds} s`;
    });
  }

  if (isFramed(win)) {
    state = 'error';
    d.show(errorView(d, 'Approval stopped', `The ${BRAND.product} approval window can’t run inside another page.`));
  } else if (!opened) {
    state = 'error';
    d.show(errorView(d, 'Nothing to review', 'This approval link is not valid. Start again from the app.'));
  } else if (!opener) {
    state = 'error';
    d.show(errorView(d, 'Nothing to review', `Open this window from the ${BRAND.product} button in the app.`));
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
