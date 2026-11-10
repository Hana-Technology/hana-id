// The approval queue and popup (docs/batch-b-spec.md "Approval flow", "Consent"). Requests queue in order. The popup
// is one of:
// - partner-opened (D99): the SDK opened `{authOrigin}/approve?from=partner&v=<vault frame>` in the user's click and
//   flagged the request `popupOpened`. Its hello comes from a window whose opener is this vault's parent, with
//   `event.origin === authOrigin`; the vault adopts it (no launcher) unless it already has a popup in use, in which case
//   it tells the newcomer to close. While a flagged request waits for its popup's hello (up to POPUP_WAIT_MS), the
//   launcher stays hidden. A flagged request that ends without an approval screen (auto-approved, refused) tells a
//   popup that has shown nothing to close (hana:approve-close), or closes it on arrival if its hello comes later.
// - vault-opened: the launcher ("Review in Hana") opens `{authOrigin}/approve` from the vault; the fallback when the
//   page had no user activation or its window.open returned null.
// Either way, an approval popup active in the last 15 s is reused (focused, no launcher). The popup decodes each
// request's bytes itself and answers with a digest of exactly what it rendered; the vault signs only when that digest
// matches its own for the queued request.
//
// Accepted only from the popup in use (the one this vault opened, or the partner-opened one it adopted), with
// `event.origin === authOrigin`:
//   hana:approve-hello   → the popup is ready: send the head of the queue (also how a partner-opened popup is adopted)
//   hana:approve-result  → {id, approved, digest} for the request on show (pending, < 5 min old, digest matches)
//   hana:consent-result  → {id, allowed, digest} for the consent screen on show (consentDigest)
//   hana:approve-bye     → the popup closes itself after 15 s idle, or the user pressed its Close now
//   hana:auto-approve-stop → "Stop auto-approving"
//   hana:email-revoke      → "Stop sharing" on the account line (D411, D442), answered hana:email-revoked
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
import type { MainnetDemoPriceBook } from '@hana-id/core/mainnet-demo-prices';
import type { AutoApprovePolicyV1 } from '@hana-id/core/policy';
import { VaultError } from './errors.ts';
import type { Launcher, LauncherHandle } from './launcher.ts';
import { type Timers, type WindowMessageEvent, type WindowRef, randomHex128 } from './runtime.ts';

export type ApprovalOutcome = 'approved' | 'rejected' | 'cancelled';

/** A request stays answerable this long. */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** A popup active this recently is reused (focused) instead of showing the launcher. */
export const POPUP_REUSE_MS = 15_000;
/**
 * A request the SDK opened a popup for (`popupOpened`) hides the launcher this long while that popup loads; then the
 * launcher shows as usual (and hides again if the popup's hello arrives after all).
 */
export const POPUP_WAIT_MS = 3_000;
/**
 * After a flagged request ended before its popup's hello arrived, a partner-opened popup that arrives within this long
 * with nothing to show is told to close at once. The popup's own adopt timeout (auth/approve-page.ts ADOPT_TIMEOUT_MS)
 * is the same length.
 */
export const LATE_CLOSE_MS = 8_000;
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
  /** The mainnet demo's prices this request was decided with (the popup shows its value with the same book). */
  demoPrices?: MainnetDemoPriceBook;
}

interface ConsentItem extends BaseItem {
  type: 'consent';
  policy: AutoApprovePolicyV1;
  policyId: string;
  expiresAtMs: number;
}

type Item = SignItem | ConsentItem;

/** A request flagged `popupOpened`, from its arrival until it ends (vault.ts). */
export interface PopupClaim {
  /** The request ended (signed, auto-approved, refused or failed). Idempotent. */
  release(): void;
}

export interface ApprovalDeps {
  authOrigin: string;
  /** window.parent: a partner-opened popup's opener must be this window. */
  parentWindow: unknown;
  appName: string;
  /**
   * Batch C11: the app's logo as the vault's latest GET /v1/app served it (already checked against the build's files
   * origin), or null; read for each message so a logo change reaches the next request.
   */
  logoUrl?: () => string | null;
  /**
   * Batch C15: the session's Support ID (`HANA-XXXX-XXXX`, from the API), or null; read for each message and shown on
   * the request screen's account line. Sent only when there is one, so a session without it sends exactly the message
   * older pages take.
   */
  supportId?: () => string | null;
  /**
   * D411, D442: whether the session's address is shared with this app (the vault's last known state), read for each
   * request: the account line then offers "Stop sharing". Absent or false: the message is exactly the older one.
   */
  emailShared?: () => boolean;
  /** "Stop sharing" was clicked: revoke every address of this app and account; resolves whether it worked. */
  onEmailRevoke?(): Promise<boolean>;
  parentOrigin: string;
  /** A pk_test_ app: every request and consent screen says Hana signs only for test networks (D39). */
  testApp?: boolean;
  /** Whether that test app has the mainnet demo on, as last read: the popup's note then says what the demo allows. */
  mainnetDemo?: () => boolean;
  open(url: string, name: string, features: string): WindowRef | null;
  launcher: Launcher;
  timers: Timers;
  /** Monotonic-enough device time for ages and reuse windows. */
  now(): number;
  /** "Stop auto-approving" was clicked in the popup. */
  onStop(): void;
  /** Whether an approval popup is open (reported to the SDK as the `approvalWindow` event); called on each change. */
  onWindow?(open: boolean): void;
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
  /** The popup is partner-opened and has not been sent anything yet. */
  private fresh = false;
  /** Flagged requests in flight; `waiting` while their popup hasn't said hello and POPUP_WAIT_MS hasn't passed. */
  private readonly claims = new Set<{ waiting: boolean; timer: unknown }>();
  /** Until when a partner-opened popup arriving with nothing to show is closed at once (LATE_CLOSE_MS). */
  private lateCloseUntil = 0;
  private windowOpen = false;

  constructor(private readonly d: ApprovalDeps) {}

  /** Queues a sign request for approval. */
  requestApproval(subject: ApprovalSubject, note?: AutoApproveNote, demoPrices?: MainnetDemoPriceBook): Promise<ApprovalOutcome> {
    return this.enqueue((base) => ({ ...base, type: 'sign', subject, ...(note ? { note } : {}), ...(demoPrices ? { demoPrices } : {}) }));
  }

  /** Queues the consent screen for a policy, ending at `expiresAtMs`. */
  requestConsent(policy: AutoApprovePolicyV1, policyId: string, expiresAtMs: number): Promise<ApprovalOutcome> {
    return this.enqueue((base) => ({ ...base, type: 'consent', policy, policyId, expiresAtMs }));
  }

  /**
   * A request flagged `popupOpened` arrived: the SDK opened an approval popup for it in the user's click. Until that
   * popup's hello (or POPUP_WAIT_MS) the launcher stays hidden. Release the claim when the request ends.
   */
  claim(): PopupClaim {
    const c = { waiting: true, timer: null as unknown };
    c.timer = this.d.timers.setTimeout(() => {
      c.waiting = false;
      this.syncLauncher();
    }, POPUP_WAIT_MS);
    this.claims.add(c);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.d.timers.clearTimeout(c.timer);
        this.claims.delete(c);
        this.claimEnded();
      },
    };
  }

  /** A flagged request ended: a partner-opened popup that nothing used is told to close (now, or when it arrives). */
  private claimEnded(): void {
    if (this.claims.size === 0 && this.queue.length === 0 && !this.current) {
      if (this.popup && this.fresh) this.dropPopup(true);
      else if (!this.popup) this.lateCloseUntil = this.d.now() + LATE_CLOSE_MS;
    }
    this.syncLauncher();
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

  private awaitingPopup(): boolean {
    for (const c of this.claims) if (c.waiting) return true;
    return false;
  }

  private syncLauncher(): void {
    const open = this.popupUsable();
    if (open !== this.windowOpen) {
      this.windowOpen = open;
      this.d.onWindow?.(open);
    }
    const wanted = this.queue.length > 0 && !this.current && !open && !this.awaitingPopup();
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
    this.fresh = false;
    this.batchDone = 0;
    this.lastActivity = this.d.now();
    this.startClosedPoll();
    this.syncLauncher();
  }

  /** The popup is open and busy: a request on show, still loading, or active in the last POPUP_REUSE_MS. */
  private popupInUse(): boolean {
    return this.popupUsable() && (this.current !== null || !this.connected || this.d.now() - this.lastActivity <= POPUP_REUSE_MS);
  }

  /**
   * A hello from a window other than the popup in use: a popup the partner page opened in the user's click (D99). It
   * is authenticated by origin (checked by the caller) and by its opener being this vault's parent, as a partner-mode
   * login popup is (login.ts acceptHello).
   */
  private partnerHello(source: unknown): void {
    if (!isOpenedBy(source, this.d.parentWindow)) return;
    const popup = source as WindowRef;
    if (this.popupInUse()) {
      // One approval window at a time: the one in use keeps the queue, the newcomer closes.
      tell(popup, this.d.authOrigin);
      try {
        this.popup?.focus();
      } catch {
        // See pump().
      }
      return;
    }
    if (this.popup) this.dropPopup(true); // A stale, idle window.
    for (const c of this.claims) c.waiting = false;
    if (this.queue.length === 0 && this.claims.size === 0 && !this.current && this.d.now() < this.lateCloseUntil) {
      // The request it was opened for already ended (auto-approved or refused) before it loaded.
      this.lateCloseUntil = 0;
      tell(popup, this.d.authOrigin);
      this.syncLauncher();
      return;
    }
    this.lateCloseUntil = 0;
    this.popup = popup;
    this.connected = true;
    this.fresh = true;
    this.batchDone = 0;
    this.lastActivity = this.d.now();
    this.startClosedPoll();
    this.pump();
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
    this.fresh = false;
    if (this.closedPoll !== null) {
      this.d.timers.clearTimeout(this.closedPoll);
      this.closedPoll = null;
    }
    if (close && popup) {
      // A window the partner page opened may not be closable from this frame: it is also told to close itself.
      tell(popup, this.d.authOrigin);
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
    this.fresh = false;
    // A popup reused for a long batch could count past the protocol's bound: clamp (the popup shows "1000 of 1000").
    const queued = Math.min(QUEUED_MAX, this.batchDone + 1 + this.queue.length);
    const position = Math.min(this.batchDone + 1, queued);
    popup.postMessage(this.message(item, position, queued, true), this.d.authOrigin);
  }

  /** The hana:approve-request or hana:consent-request for `item`; `copy` gives the popup its own bytes and policy. */
  private message(item: Item, position: number, queued: number, copy: boolean): { t: 'hana:approve-request' | 'hana:consent-request' } & Record<string, unknown> {
    const logoUrl = this.d.logoUrl?.() ?? null;
    const common = {
      v: 1,
      id: item.id,
      appName: this.d.appName,
      parentOrigin: this.d.parentOrigin,
      position,
      queued,
      ...(this.d.testApp ? { testApp: true } : {}),
      ...(this.d.testApp && this.d.mainnetDemo?.() ? { mainnetDemo: true } : {}),
      ...(logoUrl ? { logoUrl } : {}),
    } as const;
    if (item.type === 'consent') {
      return { ...common, t: 'hana:consent-request', policy: structuredPolicy(item.policy), policyId: item.policyId, expiresAtMs: item.expiresAtMs };
    }
    const supportId = this.d.supportId?.() ?? null;
    return {
      ...common,
      t: 'hana:approve-request',
      kind: item.subject.kind,
      chain: item.subject.chain,
      address: item.subject.address,
      bytes: copy ? Uint8Array.from(item.subject.bytes) : item.subject.bytes,
      context: { ...item.subject.context },
      ...(item.note ? { autoApprove: { ...item.note } } : {}),
      ...(supportId ? { supportId } : {}),
      ...(this.d.emailShared?.() ? { emailShared: true } : {}),
      ...(item.demoPrices ? { demoPrices: item.demoPrices } : {}),
    };
  }

  /** Handles a window message meant for the approval popup protocol; true if it was one (accepted or not). */
  handleMessage(e: WindowMessageEvent): boolean {
    const m = parseWindowMessage(e.data, ['hana:approve-hello', 'hana:approve-result', 'hana:consent-result', 'hana:approve-bye', 'hana:auto-approve-stop', 'hana:email-revoke']);
    if (!m) return false;
    if (e.origin !== this.d.authOrigin) return true;
    if (m.t === 'hana:approve-hello' && e.source !== this.popup) {
      this.partnerHello(e.source);
      return true;
    }
    if (!this.popup || e.source !== this.popup) return true;
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
      case 'hana:email-revoke': {
        const popup = this.popup;
        const revoke = this.d.onEmailRevoke;
        if (!revoke) break;
        void revoke()
          .catch(() => false)
          .then((ok) => {
            try {
              popup.postMessage({ v: 1, t: 'hana:email-revoked', ok }, this.d.authOrigin);
            } catch {
              // The popup is gone: nothing to tell.
            }
          });
        break;
      }
    }
    return true;
  }
}

/** Whether `w`'s opener is `parent` (a cross-origin `opener` read is allowed; anything odd is false). */
function isOpenedBy(w: unknown, parent: unknown): boolean {
  if (w === null || w === undefined || parent === null || parent === undefined) return false;
  try {
    return (w as { opener?: unknown }).opener === parent;
  } catch {
    return false;
  }
}

/** Tells a popup on authOrigin to close itself (hana:approve-close); a window that is gone is ignored. */
function tell(w: WindowRef, authOrigin: string): void {
  try {
    w.postMessage({ v: 1, t: 'hana:approve-close' }, authOrigin);
  } catch {
    // Closed or navigated away.
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
