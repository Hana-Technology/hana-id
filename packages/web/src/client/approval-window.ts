// The approval popup opened in the partner's click (docs/batch-b-spec.md "Approval flow" step 1, D95), as login opens
// its popup:
//
// - prepare() runs synchronously at the start of every signing entry point, before any await. With transient user
//   activation (`navigator.userActivation.isActive`; when the API is missing it tries anyway) it opens
//   `window.open('{authOrigin}/approve?from=partner&v=<vault frame name>', 'hana-approve-<32 hex>',
//   'popup,width=420,height=680')`, without noopener (the popup finds the vault through window.opener.frames[v]).
//   It opens nothing when an approval popup is already open, the one this page opened or one the vault reports
//   (`approvalWindow {open: true}`): the vault reuses that one (the reuse rule), and this page focuses its own.
// - claim() marks the next signing request sent on the port `popupOpened: true` while the window this page opened
//   is still open and unclaimed (for up to CLAIM_MS), so the vault holds its launcher for that window's hello and closes
//   it if the request ends without an approval screen.
// - Without activation, or when window.open returns null (a popup blocker, Safari after an await), nothing is opened
//   and the request goes to the vault's "Review in Hana" launcher as before.
//
// SECURITY: the page holds a WindowProxy to this popup, as any page holds the popups it opens: it can navigate or close
// it, but the popup accepts requests only from the authenticated vault and answers only the vault (docs/security.md
// "Approval popup opened by the partner page").
import { randomHex } from './random.ts';

export const APPROVE_POPUP_FEATURES = 'popup,width=420,height=680';
/** A window this page opened is claimed by a signing request sent this long after it (the popup's own adopt timeout). */
export const CLAIM_MS = 8_000;

/** What a signing entry point gets back from prepare(): cancel() closes the window if no request claimed it. */
export interface ApprovalTicket {
  cancel(): void;
}

const NO_TICKET: ApprovalTicket = Object.freeze({ cancel: () => {} });

interface Own {
  popup: Window;
  openedAt: number;
  claimed: boolean;
}

/** Whether the page has transient user activation; true when the browser has no `navigator.userActivation`. */
export function hasUserActivation(win: Window): boolean {
  let ua: { isActive?: unknown } | null | undefined;
  try {
    ua = (win.navigator as Navigator & { userActivation?: { isActive?: unknown } | null }).userActivation;
  } catch {
    return true;
  }
  return ua === undefined || ua === null || ua.isActive === true;
}

function isClosed(w: Window): boolean {
  try {
    return w.closed;
  } catch {
    return true;
  }
}

export class ApprovalWindows {
  #own: Own | null = null;
  #vaultOpen = false;

  constructor(
    private readonly win: Window,
    private readonly authOrigin: string,
    private readonly vaultFrameName: string,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The vault's `approvalWindow` event. */
  set vaultWindowOpen(open: boolean) {
    this.#vaultOpen = open;
  }

  /** Opens the approval popup if the page may (activation) and none is open. Synchronous: call before any await. */
  prepare(): ApprovalTicket {
    const own = this.#own;
    if (own && !isClosed(own.popup)) {
      try {
        own.popup.focus();
      } catch {
        // A cross-origin focus() can throw; the vault focuses it too.
      }
      return NO_TICKET;
    }
    // The vault learns that a window closed by polling it (every 0.5 s): when the window it reports open is most likely
    // the one this page opened and saw closed just now, its report is stale.
    const vaultOpen = this.#vaultOpen && !(own && own.claimed);
    this.#own = null;
    if (vaultOpen || !hasUserActivation(this.win)) return NO_TICKET;
    let popup: Window | null = null;
    try {
      popup = this.win.open(`${this.authOrigin}/approve?from=partner&v=${encodeURIComponent(this.vaultFrameName)}`, `hana-approve-${randomHex(16)}`, APPROVE_POPUP_FEATURES) ?? null;
    } catch {
      popup = null;
    }
    // A handle that is closed already (a COOP-severed one) is no window to wait for.
    if (!popup || isClosed(popup)) return NO_TICKET;
    const opened: Own = { popup, openedAt: this.now(), claimed: false };
    this.#own = opened;
    return {
      cancel: () => {
        if (opened.claimed || this.#own !== opened) return;
        this.#own = null;
        try {
          popup.close();
        } catch {
          // Already gone.
        }
      },
    };
  }

  /** True if the request about to be sent claims the window this page opened (it is sent `popupOpened: true`). */
  claim(): boolean {
    const own = this.#own;
    if (!own || own.claimed || isClosed(own.popup) || this.now() - own.openedAt > CLAIM_MS) return false;
    own.claimed = true;
    return true;
  }
}
