// The vault's launcher (docs/batch-b-spec.md "Approval flow" step 1, "Login" step 1, "Key export" step 1): one button
// inside the vault iframe, which the SDK shows as a fixed 320×72 px element when the vault emits `ui {launcher:
// 'show'}`. A click on it only opens a Hana window (login, approval, export) from the vault's own browsing context, so
// clickjacking it can't produce a signature: every signature still needs a guarded Approve in that window.
//
// Several things may want the launcher at once (a blocked login popup, queued approvals, an export); they queue as
// intents and the oldest one is shown. A flash ("Signed by Hana under {label}") shows for a few seconds over them.
import type { Timers } from './runtime.ts';

export interface LauncherView {
  /** Shows the button with `label`; `onClick` is null for a flash (the click does nothing). */
  show(label: string, onClick: (() => void) | null): void;
  hide(): void;
}

export interface LauncherHandle {
  /** Removes the intent (idempotent). */
  remove(): void;
  setLabel(label: string): void;
}

interface Intent {
  label: string;
  onClick: () => void;
}

export const LABEL_MAX = 80;
const clip = (label: string): string => (label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label);

export class Launcher {
  private readonly intents: Intent[] = [];
  private flashLabel: string | null = null;
  private flashTimer: unknown = null;
  private shown: string | null = null;
  private shownClickable = false;

  constructor(
    private readonly view: LauncherView,
    /** `clickable`: whether what is shown has a click action (false for a flash, and when hidden). */
    private readonly emit: (ui: { launcher: 'show' | 'hide'; label: string; clickable: boolean }) => void,
    private readonly timers: Timers,
  ) {}

  push(label: string, onClick: () => void): LauncherHandle {
    const intent: Intent = { label: clip(label), onClick };
    this.intents.push(intent);
    this.render();
    return {
      remove: () => {
        const i = this.intents.indexOf(intent);
        if (i >= 0) {
          this.intents.splice(i, 1);
          this.render();
        }
      },
      setLabel: (l: string) => {
        intent.label = clip(l);
        this.render();
      },
    };
  }

  /** Shows `label` for `ms` without a click action, then whatever was there before. */
  flash(label: string, ms: number): void {
    if (this.flashTimer !== null) this.timers.clearTimeout(this.flashTimer);
    this.flashLabel = clip(label);
    this.flashTimer = this.timers.setTimeout(() => {
      this.flashLabel = null;
      this.flashTimer = null;
      this.render();
    }, ms);
    this.render();
  }

  /** The label on show, or null when hidden (tests and status). */
  get label(): string | null {
    return this.shown;
  }

  private render(): void {
    const head = this.intents[0];
    if (this.flashLabel !== null) {
      this.view.show(this.flashLabel, null);
      this.announce(this.flashLabel, false);
    } else if (head) {
      this.view.show(head.label, () => {
        // Re-read the head at click time: it is the intent on show.
        const current = this.intents[0];
        if (current) current.onClick();
      });
      this.announce(head.label, true);
    } else {
      this.view.hide();
      if (this.shown !== null) {
        this.shown = null;
        this.shownClickable = false;
        this.emit({ launcher: 'hide', label: '', clickable: false });
      }
    }
  }

  /** Once per change: the same label shown again (a second flash of it) announces nothing. */
  private announce(label: string, clickable: boolean): void {
    if (this.shown === label && this.shownClickable === clickable) return;
    this.shown = label;
    this.shownClickable = clickable;
    this.emit({ launcher: 'show', label, clickable });
  }
}

/**
 * The launcher button in the vault document. Text goes in with textContent only (labels carry partner strings), and
 * styles are set through the CSSOM (the page's CSP has no inline style). Only trusted clicks open anything.
 */
export function domLauncherView(doc: Document): LauncherView {
  const button = doc.createElement('button');
  button.type = 'button';
  const s = button.style;
  s.position = 'fixed';
  s.inset = '0';
  s.width = '100%';
  s.height = '100%';
  s.margin = '0';
  s.border = '0';
  s.borderRadius = '12px';
  // Hana's ink with its gradient as a 3 px line along the bottom (packages/brand tokens.css, D426). The system font on
  // purpose: the vault loads no font file (its bundle and its one request stay as they are).
  s.background = 'linear-gradient(90deg, #6256e9, #7e5deb 45%, #d772d3) bottom / 100% 3px no-repeat, #16073a';
  s.color = '#ffffff';
  s.font = '600 16px system-ui, -apple-system, "Segoe UI", sans-serif';
  s.cursor = 'pointer';
  s.display = 'none';
  let onClick: (() => void) | null = null;
  button.addEventListener('click', (e) => {
    if (!e.isTrusted || !onClick) return;
    onClick();
  });
  const attach = () => {
    if (!button.isConnected) doc.body?.append(button);
  };
  return {
    show(label, click) {
      attach();
      button.textContent = label;
      onClick = click;
      button.disabled = click === null;
      s.cursor = click === null ? 'default' : 'pointer';
      s.display = 'block';
    },
    hide() {
      onClick = null;
      s.display = 'none';
    },
  };
}
