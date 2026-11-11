// The key reveal the export window (export-page.ts) and Hana Home (home-page.ts) share: the buttons that sit behind
// the approval popup's guard, and the box that shows a private key on "Show key" / "Hide key" and copies it on
// "Copy key". One implementation, so the safeguards are the same wherever a key can appear.
//
// What it does:
// - Continue, Show key and Copy key act only on a real click that started after the guard armed (approve-guard.ts:
//   1 s after the screen and the window's focus, then a moving pointer or Tab, the keyboard dwell). Hide never waits.
// - A shown key hides again EXPORT_SHOW_MS (60 s) after Show, when the window loses focus, when the tab is hidden and
//   before the page is printed. Hidden, the box holds dots and can't be selected.
// - Copy writes to the clipboard inside the click and never puts the key in the page. The reveal tries to blank a key
//   it copied EXPORT_CLIPBOARD_CLEAR_MS after the last copy and when it ends, while the window has focus. It never
//   reads the clipboard.
//
// SECURITY: the reveal never holds the key. It asks its caller for the export string at each Show or Copy (`secret`),
// puts it in one text node or hands it to the clipboard, and keeps no other reference. A string can't be zeroed: once
// the text node is replaced it is only unreachable, until the engine collects it. The box is `translate="no"` and has
// no `aria-live`, so a translator or a screen reader never takes the key on its own. Nothing here logs.
import { exportStringOf } from '@hana-id/core';
import { ApproveGuard, type GuardInput, guardInputOf } from './approve-guard.ts';
import type { Dom } from './dom.ts';
import type { GestureCheck, PageWindow } from './page-window.ts';

/** What the user types to confirm. */
export const EXPORT_CONFIRMATION = 'EXPORT';
/** How long after the last copy the page tries to blank the clipboard. */
export const EXPORT_CLIPBOARD_CLEAR_MS = 60_000;
/** How long a shown key stays on screen before it hides again; Show key shows it again. */
export const EXPORT_SHOW_MS = 60_000;
/** What the key is, in plain words: shown before the sign-in and again before the key. */
export const EXPORT_WARNING =
  'Anyone with this key controls your funds at this address, in every app and wallet. Hana can’t recover it for you or undo what someone does with it. Never paste it into a website, and never share it with anyone, including Hana.';
/** How long "Copy key" says "Copied". */
export const EXPORT_COPIED_MS = 2_000;
/** Shown when the Clipboard API is missing or refuses the write. */
export const EXPORT_COPY_UNAVAILABLE = 'Copy isn’t available here: show the key and copy it by hand.';
/** What a copied key means for the user, under the reveal. */
export const EXPORT_CLIPBOARD_NOTE =
  'A copied key stays in your clipboard until you copy something else, and other apps or your clipboard history may read it there: paste it only into the wallet you are moving to. We try to clear it after 60 seconds if this window is still open, but not every browser allows that, so the copy is yours to look after.';
const HIDDEN_TEXT = '••••••••';

/** The one Clipboard API call a reveal makes: it writes, it never reads. */
export interface ExportClipboard {
  writeText(text: string): Promise<void>;
}

/** `navigator.clipboard` when this browser has the Clipboard API's write here (a secure context), else null. */
export function browserClipboard(): ExportClipboard | null {
  try {
    const c = (globalThis as { navigator?: { clipboard?: Partial<ExportClipboard> } }).navigator?.clipboard;
    return c && typeof c.writeText === 'function' ? (c as ExportClipboard) : null;
  } catch {
    return null;
  }
}

/** The export string of a chain private key (StrKey S…, 0x + 64 hex, or NEAR's ed25519: + base58(seed ‖ public key)). */
export const exportString = (chain: 'stellar' | 'evm' | 'near', key: Uint8Array): string => exportStringOf(chain, key);

/** The guard over one screen's buttons. */
export interface ScreenGuard {
  /** Puts `el` behind the guard on this screen: disabled until armed (and `ready`), its keyboard dwell tracked. */
  button(el: HTMLButtonElement, ready?: () => boolean): void;
  /** A new screen: forget the old buttons. */
  newScreen(): void;
  /** The new screen is in the page: the guard starts over (1 s, then an arming gesture). */
  rendered(): void;
  /** Brings each button's `disabled` up to date (after a `ready` condition changed). */
  sync(): void;
  /** Whether a click on a guarded button acts: a real gesture, the guard armed, the click started after it. */
  click(e: Event): boolean;
}

export interface ScreenGuardDeps {
  win: PageWindow;
  isGesture: GestureCheck;
  /** Whether the window has focus (`document.hasFocus()`); may throw, which reads as no focus. */
  hasFocus: () => boolean;
  /** The guard's clock (default: Date.now; tests inject one). */
  now?: () => number;
}

/** Makes the page's guard and listens for what feeds it: focus, visibility and arming gestures in this window. */
export function screenGuard(deps: ScreenGuardDeps): ScreenGuard {
  const { win, isGesture } = deps;
  const now = deps.now ?? (() => Date.now());
  let guarded: { el: HTMLButtonElement; ready: () => boolean }[] = [];
  const visibleNow = () => win.document.visibilityState !== 'hidden';
  const focusedNow = () => {
    try {
      return deps.hasFocus();
    } catch {
      return false;
    }
  };
  const sync = (): void => {
    const armed = guard.armed();
    for (const g of guarded) g.el.disabled = !(armed && g.ready());
  };
  const guard = new ApproveGuard(now, visibleNow() && focusedNow() ? now() : null, () => sync());
  const onGesture = (type: GuardInput['type']) => (e: Event) => {
    if (isGesture(e)) guard.gesture(guardInputOf(type, e));
  };
  win.addEventListener('pointermove', onGesture('pointermove'));
  win.addEventListener('pointerdown', onGesture('pointerdown'));
  win.addEventListener('keydown', onGesture('keydown'));
  win.addEventListener('focus', () => guard.focused());
  win.addEventListener('blur', () => guard.blurred());
  win.document.addEventListener('visibilitychange', () => (visibleNow() ? guard.focused() : guard.blurred()));
  return {
    button(el, ready = () => true) {
      guarded.push({ el, ready });
      el.addEventListener('focus', () => guard.primaryFocused());
      el.addEventListener('blur', () => guard.primaryBlurred());
      el.disabled = true;
    },
    newScreen() {
      guarded = [];
    },
    rendered() {
      guard.rendered();
      sync();
    },
    sync,
    click: (e) => isGesture(e) && guard.mayActivate((e as MouseEvent).detail === 0),
  };
}

export interface KeyRevealDeps {
  d: Dom;
  win: PageWindow;
  guard: ScreenGuard;
  isGesture: GestureCheck;
  /** The Clipboard API's write, or null when the browser has none here. */
  clipboard: () => ExportClipboard | null;
  /** Whether the window has focus: a clipboard write without it is refused by every browser. */
  hasFocus: () => boolean;
  /** Whether the key is still there to show or copy. It may end the export (a deadline that passed). */
  ready: () => boolean;
  /** The key's export string, made for this one Show or Copy, or null when the key is gone. Called only after `ready`. */
  secret: () => string | null;
}

export interface KeyReveal {
  /** The box the key shows in. */
  readonly out: HTMLElement;
  /** "Show key" / "Hide key" and "Copy key". */
  readonly actions: HTMLElement;
  /** The copy's outcome when it failed; never the key. */
  readonly status: HTMLElement;
  readonly shown: boolean;
  hide(): void;
  /** The key is gone: takes it off the screen for good, stops the timers, tries to blank a copy, lets go of the window. */
  end(): void;
}

/** Builds the reveal's elements; the caller places them and then calls `guard.rendered()`. */
export function keyReveal(deps: KeyRevealDeps): KeyReveal {
  const { d, win, guard, isGesture } = deps;
  // No aria-live: a screen reader reads the key only when the user moves to it, never on its own; and translate="no",
  // so a page translator never sends it anywhere. Selectable only while shown.
  const out = d.h('code', { class: 'secret mono', attrs: { translate: 'no' } }, HIDDEN_TEXT);
  const toggle = d.h('button', { class: 'primary', attrs: { type: 'button', 'aria-pressed': 'false' } }, 'Show key');
  const copy = d.h('button', { attrs: { type: 'button' } }, 'Copy key');
  const status = d.h('p', { class: 'copy-status', attrs: { role: 'status' } });
  let shown = false;
  let ended = false;
  /** A copy of the key went to the clipboard and the reveal hasn't blanked it since. */
  let copied = false;
  let copiedLabel: ReturnType<typeof setTimeout> | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let clipboardTimer: ReturnType<typeof setTimeout> | null = null;
  // Show needs the guard; Hide never does (the click handler lets a shown key hide whatever the guard says).
  guard.button(toggle);
  guard.button(copy);

  const hide = (): void => {
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = null;
    shown = false;
    out.textContent = HIDDEN_TEXT;
    out.removeAttribute('data-shown');
    toggle.textContent = 'Show key';
    toggle.setAttribute('aria-pressed', 'false');
  };
  const show = (): void => {
    if (ended || !deps.ready()) return;
    const text = deps.secret();
    if (text === null) return;
    shown = true;
    out.textContent = text;
    out.setAttribute('data-shown', '');
    toggle.textContent = 'Hide key';
    toggle.setAttribute('aria-pressed', 'true');
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = setTimeout(hide, EXPORT_SHOW_MS);
  };

  /**
   * Best effort: writes an empty string over a key this reveal copied, only while the window has focus (every browser
   * refuses a clipboard write without it; Firefox and Safari also want a user gesture, so there it fails quietly). It
   * never reads the clipboard, so it can't tell whether the user has copied something else since.
   */
  function clearClipboard(): void {
    if (clipboardTimer !== null) clearTimeout(clipboardTimer);
    clipboardTimer = null;
    const c = deps.clipboard();
    if (!copied || !c) return;
    let focused: boolean;
    try {
      focused = deps.hasFocus();
    } catch {
      focused = false;
    }
    if (!focused) return;
    try {
      c.writeText('').then(
        () => {
          copied = false;
        },
        () => {},
      );
    } catch {
      // Refused at once: nothing more to do.
    }
  }

  // Enter and Space on a focused button fire its click, so one handler serves mouse, touch and keyboard.
  toggle.addEventListener('click', (e) => {
    if (!isGesture(e)) return;
    if (shown) hide();
    else if (guard.click(e)) show();
  });
  const copyUnavailable = (): void => {
    if (!ended) status.textContent = EXPORT_COPY_UNAVAILABLE;
  };
  const onCopied = (): void => {
    copied = true;
    // Ended while the write was pending: blank what just landed, if the browser lets us.
    if (ended) {
      clearClipboard();
      return;
    }
    status.textContent = '';
    copy.textContent = 'Copied';
    if (copiedLabel !== null) clearTimeout(copiedLabel);
    copiedLabel = setTimeout(() => {
      copiedLabel = null;
      copy.textContent = 'Copy key';
    }, EXPORT_COPIED_MS);
    if (clipboardTimer !== null) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(clearClipboard, EXPORT_CLIPBOARD_CLEAR_MS);
  };
  copy.addEventListener('click', (e) => {
    if (ended || !guard.click(e) || !deps.ready()) return;
    const c = deps.clipboard();
    if (!c) {
      copyUnavailable();
      return;
    }
    const text = deps.secret();
    if (text === null) return;
    // Inside the click, before any await, so the browser counts the user's gesture. No execCommand('copy') fallback:
    // it would put the key in a hidden, selected text field.
    let write: Promise<void>;
    try {
      write = c.writeText(text);
    } catch {
      copyUnavailable();
      return;
    }
    write.then(onCopied, copyUnavailable);
  });

  const onHidden = (): void => {
    if (win.document.visibilityState === 'hidden') hide();
  };
  win.addEventListener('blur', hide);
  // A printed page, or one saved as a PDF, would carry a shown key: it hides first. (The stylesheet hides the box in
  // print as well, for a browser that prints without the event.)
  win.addEventListener('beforeprint', hide);
  win.document.addEventListener('visibilitychange', onHidden);

  return {
    out,
    actions: d.h('div', { class: 'actions reveal' }, toggle, copy),
    status,
    get shown() {
      return shown;
    },
    hide,
    end() {
      if (ended) return;
      ended = true;
      hide();
      if (copiedLabel !== null) clearTimeout(copiedLabel);
      copiedLabel = null;
      clearClipboard();
      win.removeEventListener('blur', hide);
      win.removeEventListener('beforeprint', hide);
      win.document.removeEventListener('visibilitychange', onHidden);
    },
  };
}
