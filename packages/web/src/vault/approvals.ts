// The approval queue and popup (docs/batch-b-spec.md "Approval flow", "Consent"). Requests queue in order; the
// launcher ("Review in Hana") opens `{authOrigin}/approve` from the vault, or the vault reuses an approval popup that
// was active in the last 15 s (focusing it, no launcher). The popup decodes each request's bytes itself and answers with
// a digest of exactly what it rendered; the vault signs only when that digest matches its own for the queued request.
//
// Accepted only from the popup this vault opened, with `event.origin === authOrigin`:
//   hana:approve-hello   → the popup is ready: send the head of the queue
//   hana:approve-result  → {id, approved, digest} for the request on show (pending, < 5 min old, digest matches)
//   hana:consent-result  → {id, allowed, digest} for the consent screen on show (consentDigest)
//   hana:approve-bye     → the popup closes itself after 15 s idle
//   hana:auto-approve-stop → "Stop auto-approving"
// Reject, a popup closed while a request is on show, or a request older than 5 min resolves 'rejected' (4001).
// A request is refused at once (4100) when MAX_PENDING_APPROVALS are already waiting or on show, or when the message
// the popup would get fails the popup's own validator (parseWindowMessage), which would otherwise drop it silently and
// leave the request hanging until its 5 min end.
import {
  type ApprovalSubject,
  type AutoApproveNote,
  ErrorCode,
  approvalDigest,
  consentDigest,
  digestsEqual,
  newRequestId,
  parseWindowMessage,
} from '@hana-id/core';
import type { AutoApprovePolicyV1 } from '@hana-id/core/policy';
import { VaultError } from './errors.ts';
import type { Launcher, LauncherHandle } from './launcher.ts';
import { type Timers, type WindowMessageEvent, type WindowRef, randomHex128 } from './runtime.ts';

export type ApprovalOutcome = 'approved' | 'rejected' | 'cancelled';

/** A request stays answerable this long. */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** A popup active this recently is reused (focused) instead of showing the launcher. */
export const POPUP_REUSE_MS = 15_000;
const CLOSED_POLL_MS = 500;
export const APPROVE_LABEL = 'Review in Hana';
export const APPROVE_FEATURES = 'popup,width=420,height=680';
/** Requests waiting or on show at once; more are refused (a script on the page can't queue without limit). */
export const MAX_PENDING_APPROVALS = 100;
/** The protocol's bound on `queued` (and so on `position`) in hana:approve-request and hana:consent-request. */
const QUEUED_MAX = 1000;

interface BaseItem {
  id: string;
  createdAt: number;
  timer: unknown;
  settle(outcome: ApprovalOutcome): void;
}

interface SignItem extends BaseItem {
  type: 'sign';
  subject: ApprovalSubject;
  note?: AutoApproveNote;
}

interface ConsentItem extends BaseItem {
  type: 'consent';
  policy: AutoApprovePolicyV1;
  policyId: string;
  expiresAtMs: number;
}

type Item = SignItem | ConsentItem;

export interface ApprovalDeps {
  authOrigin: string;
  appName: string;
  parentOrigin: string;
  /** A pk_test_ app: every request and consent screen says Hana signs only for test networks (D39). */
  testApp?: boolean;
  open(url: string, name: string, features: string): WindowRef | null;
  launcher: Launcher;
  timers: Timers;
  /** Monotonic-enough device time for ages and reuse windows. */
  now(): number;
  /** "Stop auto-approving" was clicked in the popup. */
  onStop(): void;
}

export class Approvals {
  private readonly queue: Item[] = [];
  private current: Item | null = null;
  private popup: WindowRef | null = null;
  private connected = false;
  private lastActivity = 0;
  private batchDone = 0;
  private launcherHandle: LauncherHandle | null = null;
  private closedPoll: unknown = null;

  constructor(private readonly d: ApprovalDeps) {}

  /** Queues a sign request for approval. */
  requestApproval(subject: ApprovalSubject, note?: AutoApproveNote): Promise<ApprovalOutcome> {
    return this.enqueue((base) => ({ ...base, type: 'sign', subject, ...(note ? { note } : {}) }));
  }

  /** Queues the consent screen for a policy, ending at `expiresAtMs`. */
  requestConsent(policy: AutoApprovePolicyV1, policyId: string, expiresAtMs: number): Promise<ApprovalOutcome> {
    return this.enqueue((base) => ({ ...base, type: 'consent', policy, policyId, expiresAtMs }));
  }

  /** Number of requests waiting or on show. */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /** Settles every request with `outcome` (logout, expiry) and closes the popup. */
  cancelAll(outcome: ApprovalOutcome = 'cancelled'): void {
    const items = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue.length = 0;
    for (const item of items) this.finish(item, outcome);
    this.dropPopup(true);
    this.syncLauncher();
  }

  private enqueue(make: (base: BaseItem) => Item): Promise<ApprovalOutcome> {
    if (this.pending >= MAX_PENDING_APPROVALS) {
      return Promise.reject(new VaultError(ErrorCode.unauthorized, 'Too many requests are waiting for approval', { reason: 'too_many_pending' }));
    }
    let resolve: (o: ApprovalOutcome) => void = () => undefined;
    const done = new Promise<ApprovalOutcome>((r) => {
      resolve = r;
    });
    let settled = false;
    const item = make({
      id: newRequestId(),
      createdAt: this.d.now(),
      timer: null,
      settle: (o) => {
        if (settled) return;
        settled = true;
        resolve(o);
      },
    });
    // position and queued are numbers of a fixed size, so this probe stands for every message the item can produce.
    const probe = this.message(item, 1, 1, false);
    if (!parseWindowMessage(probe, [probe.t])) {
      return Promise.reject(new VaultError(ErrorCode.unauthorized, 'The request is too large or malformed to show', { reason: 'invalid_request' }));
    }
    item.timer = this.d.timers.setTimeout(() => this.expire(item), APPROVAL_TTL_MS);
    this.queue.push(item);
    this.pump();
    return done;
  }

  private expire(item: Item): void {
    if (this.current === item) {
      this.current = null;
      this.batchDone += 1;
    } else {
      const i = this.queue.indexOf(item);
      if (i < 0) return;
      this.queue.splice(i, 1);
    }
    this.finish(item, 'rejected');
    this.pump();
  }

  private finish(item: Item, outcome: ApprovalOutcome): void {
    this.d.timers.clearTimeout(item.timer);
    item.settle(outcome);
  }

  private popupUsable(): boolean {
    return this.popup !== null && !isClosed(this.popup);
  }

  /** Sends the next request to a connected popup, or shows the launcher. */
  private pump(): void {
    if (this.current) return;
    const next = this.queue[0];
    if (!next) {
      this.syncLauncher();
      return;
    }
    if (this.popupUsable() && this.connected && this.d.now() - this.lastActivity <= POPUP_REUSE_MS) {
      this.send(next);
      try {
        this.popup?.focus();
      } catch {
        // A cross-origin focus() can throw in some browsers; the request is on show either way.
      }
    } else if (this.popupUsable() && !this.connected) {
      // Opened from the launcher and not ready yet: its hello sends the request.
    } else {
      if (this.popupUsable()) this.dropPopup(true);
    }
    this.syncLauncher();
  }

  private syncLauncher(): void {
    const wanted = this.queue.length > 0 && !this.current && !this.popupUsable();
    if (wanted && !this.launcherHandle) this.launcherHandle = this.d.launcher.push(APPROVE_LABEL, () => this.openPopup());
    if (!wanted && this.launcherHandle) {
      this.launcherHandle.remove();
      this.launcherHandle = null;
    }
  }

  /** The launcher click: opens the approval popup (synchronously, inside the click). */
  private openPopup(): void {
    if (this.popupUsable()) return;
    const popup = this.d.open(`${this.d.authOrigin}/approve`, `hana-approve-${randomHex128()}`, APPROVE_FEATURES);
    if (!popup) return; // Blocked: the launcher stays.
    this.popup = popup;
    this.connected = false;
    this.batchDone = 0;
    this.lastActivity = this.d.now();
    this.startClosedPoll();
    this.syncLauncher();
  }

  private startClosedPoll(): void {
    if (this.closedPoll !== null) return;
    const tick = () => {
      this.closedPoll = null;
      if (!this.popup) return;
      if (isClosed(this.popup)) {
        this.popupGone();
        return;
      }
      this.closedPoll = this.d.timers.setTimeout(tick, CLOSED_POLL_MS);
    };
    this.closedPoll = this.d.timers.setTimeout(tick, CLOSED_POLL_MS);
  }

  private dropPopup(close: boolean): void {
    const popup = this.popup;
    this.popup = null;
    this.connected = false;
    if (this.closedPoll !== null) {
      this.d.timers.clearTimeout(this.closedPoll);
      this.closedPoll = null;
    }
    if (close && popup) {
      try {
        popup.close();
      } catch {
        // Already gone.
      }
    }
  }

  /** The popup closed (or said bye): the request on show is rejected; the rest wait for the launcher. */
  private popupGone(): void {
    this.dropPopup(false);
    const shown = this.current;
    this.current = null;
    if (shown) this.finish(shown, 'rejected');
    this.pump();
  }

  private send(item: Item): void {
    const popup = this.popup;
    if (!popup) return;
    this.queue.shift();
    this.current = item;
    // A popup reused for a long batch could count past the protocol's bound: clamp (the popup shows "1000 of 1000").
    const queued = Math.min(QUEUED_MAX, this.batchDone + 1 + this.queue.length);
    const position = Math.min(this.batchDone + 1, queued);
    popup.postMessage(this.message(item, position, queued, true), this.d.authOrigin);
  }

  /** The hana:approve-request or hana:consent-request for `item`; `copy` gives the popup its own bytes and policy. */
  private message(item: Item, position: number, queued: number, copy: boolean): { t: 'hana:approve-request' | 'hana:consent-request' } & Record<string, unknown> {
    const common = { v: 1, id: item.id, appName: this.d.appName, parentOrigin: this.d.parentOrigin, position, queued, ...(this.d.testApp ? { testApp: true } : {}) } as const;
    if (item.type === 'consent') {
      return { ...common, t: 'hana:consent-request', policy: structuredPolicy(item.policy), policyId: item.policyId, expiresAtMs: item.expiresAtMs };
    }
    return {
      ...common,
      t: 'hana:approve-request',
      kind: item.subject.kind,
      chain: item.subject.chain,
      address: item.subject.address,
      bytes: copy ? Uint8Array.from(item.subject.bytes) : item.subject.bytes,
      context: { ...item.subject.context },
      ...(item.note ? { autoApprove: { ...item.note } } : {}),
    };
  }

  /** Handles a window message meant for the approval popup protocol; true if it was one (accepted or not). */
  handleMessage(e: WindowMessageEvent): boolean {
    const m = parseWindowMessage(e.data, ['hana:approve-hello', 'hana:approve-result', 'hana:consent-result', 'hana:approve-bye', 'hana:auto-approve-stop']);
    if (!m) return false;
    if (!this.popup || e.source !== this.popup || e.origin !== this.d.authOrigin) return true;
    switch (m.t) {
      case 'hana:approve-hello':
        this.connected = true;
        this.lastActivity = this.d.now();
        // A reloaded popup lost what it showed: show it again.
        if (this.current) {
          const again = this.current;
          this.current = null;
          this.queue.unshift(again);
        }
        this.pump();
        break;
      case 'hana:approve-result':
      case 'hana:consent-result': {
        const item = this.current;
        if (!item || item.id !== m.id || !this.connected) break;
        if (this.d.now() - item.createdAt >= APPROVAL_TTL_MS) break;
        let outcome: ApprovalOutcome = 'rejected';
        if (m.t === 'hana:approve-result' && item.type === 'sign') {
          if (m.approved && digestsEqual(m.digest, approvalDigest({ ...item.subject, id: item.id, parentOrigin: this.d.parentOrigin }))) outcome = 'approved';
        } else if (m.t === 'hana:consent-result' && item.type === 'consent') {
          const expected = consentDigest({ id: item.id, policyId: item.policyId, parentOrigin: this.d.parentOrigin, expiresAtMs: item.expiresAtMs });
          if (m.allowed && digestsEqual(m.digest, expected)) outcome = 'approved';
        } else {
          break; // An approval answer to a consent screen or the reverse: ignored.
        }
        this.current = null;
        this.batchDone += 1;
        this.lastActivity = this.d.now();
        this.finish(item, outcome);
        this.pump();
        break;
      }
      case 'hana:approve-bye':
        this.popupGone();
        break;
      case 'hana:auto-approve-stop':
        this.d.onStop();
        break;
    }
    return true;
  }
}

function isClosed(w: WindowRef): boolean {
  try {
    return w.closed;
  } catch {
    return true;
  }
}

/** A plain-object copy of the policy (frozen objects clone fine, but a copy keeps the queue's value private). */
const structuredPolicy = (policy: AutoApprovePolicyV1): Record<string, unknown> => JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
