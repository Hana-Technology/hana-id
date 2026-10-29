// `GET {authOrigin}/approve` (docs/batch-b-spec.md "Approval flow" and "Consent"): the approval popup the vault opens
// from its launcher. It talks only to its opener on vaultOrigin, decodes every request's bytes itself, and answers
// with a digest computed from exactly what it rendered (the approval digest, or the consent digest for the
// auto-approve consent screen), so the vault signs only what the user saw. Approve and Allow are guarded
// (approve-guard.ts). After an answer it waits up to 15 s for a follow-up request, then says bye and closes.
//
// One request is on screen at a time. If the vault sends another (a different id) while one is still unanswered, the
// one on screen is rejected first (approve-result approved: false, or consent-result allowed: false, with its own
// digest), so the vault never waits on an id the user can no longer answer; the new one needs its own guarded Approve.
// The same id sent again (the vault re-sending what is on show) is rendered again, which also resets the guard.
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
import { ApproveGuard, type Coords, type GuardInput } from './approve-guard.ts';
import { type Dom, dom, errorView } from './dom.ts';
import { type GestureCheck, type PageWindow, isFramed, isUserGesture } from './page-window.ts';
import { renderApproval } from './render-approval.ts';
import { renderConsent } from './render-consent.ts';

/** How long the popup waits for a follow-up request after an answer before it closes. */
export const KEEP_OPEN_MS = 15_000;

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
  const d: Dom = dom(win.document);
  const opener = win.opener;
  let state: ApprovePageState = 'connecting';
  let current: Current | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let primary: HTMLButtonElement | null = null;
  let stopped = false;
  const visible = () => win.document.visibilityState !== 'hidden';
  const hasFocus = () => (typeof win.document.hasFocus === 'function' ? win.document.hasFocus() : true);
  const guard = new ApproveGuard(now, visible() && hasFocus() ? now() : null, (armed) => {
    if (primary) primary.disabled = !armed;
  });

  const post = (m: Record<string, unknown>) => {
    try {
      opener?.postMessage({ v: 1, ...m }, env.vaultOrigin);
    } catch {
      // The vault is gone (partner page closed or navigated); nothing to answer.
    }
  };

  const onGesture = (type: GuardInput['type']) => (e: Event) => {
    if (isGesture(e)) guard.gesture(guardInput(type, e));
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
    if (stopped || e.source !== opener || e.origin !== env.vaultOrigin) return;
    const msg = parseWindowMessage(e.data, ['hana:approve-request', 'hana:consent-request']);
    if (!msg) return;
    clearTimeout(idleTimer);
    if (msg.t === 'hana:approve-request') showRequest(msg);
    else showConsent(msg);
  }

  /** Closing the popup with something on screen answers it: Reject (the vault also maps a closed popup to 4001). */
  function onPageHide(): void {
    if (current) answer(false);
    stop();
  }

  function header(msg: { appName: string; parentOrigin: string }, extra?: string): HTMLElement {
    return d.h(
      'header',
      { class: 'app' },
      d.h('p', {}, extra ? `${extra} from ` : 'From ', d.h('strong', {}, msg.appName)),
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
    ok.addEventListener('click', (e) => {
      // The guard is checked here too, not only through `disabled`, and the click must have started (pointerdown, or
      // keydown for a keyboard click, whose detail is 0) after the gesture that armed it.
      if (isGesture(e) && enabled && guard.mayActivate((e as MouseEvent).detail === 0)) answer(true);
    });
    primary = enabled ? ok : null;
    return d.h('div', { class: 'actions' }, reject, enabled ? ok : null);
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
    d.show(
      d.h(
        'section',
        { class: 'panel approve' },
        header(msg, `Request ${msg.position} of ${msg.queued}`),
        d.h('p', { class: 'account' }, `Your ${msg.chain === 'stellar' ? 'Stellar' : 'EVM'} account `, d.h('code', { class: 'mono' }, msg.address)),
        msg.testApp ? d.h('p', { class: 'note test-app' }, TEST_APP_NOTE) : null,
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

  /** Closes after KEEP_OPEN_MS without a request, saying bye so the vault stops reusing this window. */
  function idleClose(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      post({ t: 'hana:approve-bye' });
      close();
    }, KEEP_OPEN_MS);
  }

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
  } else if (!opener) {
    state = 'error';
    d.show(errorView(d, 'Nothing to review', 'Open this window from the Hana prompt in the app.'));
  } else {
    for (const [t, l] of listeners) win.addEventListener(t, l);
    win.document.addEventListener('visibilitychange', onVisibility);
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Review in Hana'), d.h('p', { class: 'muted' }, 'Loading the request…')));
    post({ t: 'hana:approve-hello' });
    idleClose();
  }

  return {
    get state() {
      return state;
    },
    guard,
    stop,
  };
}

/** The client and screen coordinates of a pointer event (each only when it is a number). */
function position(o: Partial<PointerEvent>): Coords {
  const out: Coords = {};
  for (const k of ['clientX', 'clientY', 'screenX', 'screenY'] as const) if (typeof o[k] === 'number') out[k] = o[k];
  return out;
}

/** The fields of a pointer or keyboard event the guard reads (approve-guard.ts). */
function guardInput(type: GuardInput['type'], e: Event): GuardInput {
  const o = e as Partial<PointerEvent & KeyboardEvent>;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const pointerType = str(o.pointerType);
  switch (type) {
    case 'pointermove': {
      const movementX = num(o.movementX);
      const movementY = num(o.movementY);
      return { type, ...(pointerType !== undefined ? { pointerType } : {}), ...(movementX !== undefined ? { movementX } : {}), ...(movementY !== undefined ? { movementY } : {}), ...position(o) };
    }
    case 'pointerdown':
      return { type, ...(pointerType !== undefined ? { pointerType } : {}), ...position(o) };
    case 'keydown': {
      const key = str(o.key);
      return { type, ...(key !== undefined ? { key } : {}), repeat: o.repeat === true };
    }
  }
}
