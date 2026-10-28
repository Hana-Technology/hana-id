// `GET {authOrigin}/approve` (docs/batch-b-spec.md "Approval flow" and "Consent"): the approval popup the vault opens
// from its launcher. It talks only to its opener on vaultOrigin, decodes every request's bytes itself, and answers
// with a digest computed from exactly what it rendered (the approval digest, or the consent digest for the
// auto-approve consent screen), so the vault signs only what the user saw. Approve and Allow are guarded
// (approve-guard.ts). After an answer it waits up to 15 s for a follow-up request, then says bye and closes.
import {
  type ApprovalDigestInput,
  DecodeError,
  type WindowMessage,
  approvalDigest,
  consentDigest,
  parseWindowMessage,
} from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest } from '@hana-id/core/decode';
import { type AutoApprovePolicyV1, parseAutoApprovePolicy, policyId } from '@hana-id/core/policy';
import type { HanaEnv } from '../hana-env.ts';
import { ApproveGuard } from './approve-guard.ts';
import { type Dom, dom, errorView } from './dom.ts';
import { type GestureCheck, type PageWindow, isFramed, isUserGesture } from './page-window.ts';
import { renderApproval } from './render-approval.ts';
import { renderConsent } from './render-consent.ts';

/** How long the popup waits for a follow-up request after an answer before it closes. */
export const KEEP_OPEN_MS = 15_000;

export interface ApprovePageDeps {
  win: PageWindow;
  env: HanaEnv;
  now?: () => number;
  /** Whether a click is a real user gesture (event.isTrusted; tests inject one). */
  isGesture?: GestureCheck;
}

type Current =
  | { readonly kind: 'request'; readonly msg: WindowMessage<'hana:approve-request'>; readonly input: ApprovalDigestInput; readonly decodable: boolean }
  | { readonly kind: 'consent'; readonly msg: WindowMessage<'hana:consent-request'>; readonly policyId: string; readonly valid: boolean };

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

  const listeners: [string, (e: Event) => void][] = [
    ['message', onMessage],
    ['focus', () => guard.focused()],
    ['blur', () => guard.blurred()],
    ['pointermove', () => guard.pointerMoved()],
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
      // The guard is checked here too, not only through `disabled`.
      if (isGesture(e) && enabled && guard.armed()) answer(true);
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

  function showRequest(msg: WindowMessage<'hana:approve-request'>): void {
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
        auto?.miss ? d.h('p', { class: 'note' }, `Not signed automatically under “${auto.label}”: ${auto.miss.detail || auto.miss.reason}`) : null,
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
    let policy: AutoApprovePolicyV1 | null = null;
    let id = '';
    const parsed = parseAutoApprovePolicy(msg.policy);
    if (parsed.ok) {
      try {
        id = policyId(parsed.policy);
        policy = id === msg.policyId ? parsed.policy : null;
      } catch {
        policy = null;
      }
    }
    current = { kind: 'consent', msg, policyId: policy ? id : msg.policyId, valid: policy !== null };
    state = 'consent';
    d.show(
      d.h(
        'section',
        { class: 'panel consent' },
        header(msg),
        policy
          ? renderConsent(d, policy, msg.appName, msg.parentOrigin)
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

  function answer(approved: boolean): void {
    const c = current;
    if (!c) return;
    current = null;
    primary = null;
    if (c.kind === 'request') {
      post({ t: 'hana:approve-result', id: c.msg.id, approved: approved && c.decodable, digest: approvalDigest(c.input) });
    } else {
      post({ t: 'hana:consent-result', id: c.msg.id, granted: approved && c.valid, digest: consentDigest({ id: c.msg.id, parentOrigin: c.msg.parentOrigin, policyId: c.policyId }) });
    }
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
