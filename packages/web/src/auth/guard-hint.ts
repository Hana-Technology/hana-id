// The line under a guarded button (D878): while the Approve guard (approve-guard.ts, D36, D113) holds Approve, Allow,
// Share email, Continue, Show key or Copy key disabled, one short plain line says what to do, and it goes when the
// button enables. Display only: it never reads or changes the guard. The page tells it what it tells the guard (a new
// screen, focus, blur, nothing to answer, each input) and when the guard's state changes; the hint keeps its own copy of
// the guard's two 1 s marks (GUARD_DELAY_MS) only to choose its words. A wrong guess here changes a sentence, never
// what a press does.
//
// What it says, and why each is true:
// - for the first GUARD_DELAY_MS after a new screen or after the window gains focus: "One moment…" (nothing arms yet);
// - then, by the input last seen in the window (before any, the device's main pointer: a touch screen or a mouse):
//   mouse "Move your mouse to continue." (only a move arms; a click in place never does), touch "Tap the screen once
//   to continue." (after the wait, one tap anywhere arms, and that tap never approves; the next tap on the button
//   does), keyboard "Press Tab to reach {button}. Pause there before pressing Enter." (Tab arms; a keyboard press acts
//   only after the button has held focus for KEYBOARD_DWELL_MS);
// - while the window has no focus (for longer than AWAY_MS, so a quick focus change doesn't flicker): "Click or tap
//   this window to continue." (nothing arms without focus);
// - nothing while the button is enabled, while there is nothing to answer, or while the button is held back for
//   another reason (the page says so through `active`).
// It is a plain paragraph: not a button, not focusable, not a live region (the guard resets on every focus change, so
// announcing each change would repeat itself); the guarded buttons name it in `aria-describedby`, so a screen reader
// reads it with them. Its space is kept (auth.css `.guard-hint`: two lines), so nothing moves when it appears or goes.
import { GUARD_DELAY_MS, type GuardInput } from './approve-guard.ts';
import type { Dom } from './dom.ts';

export type HintInput = 'mouse' | 'touch' | 'keyboard';

/** The hint's words (D878, plain per D853). */
export const GUARD_HINT_TEXT = Object.freeze({
  wait: 'One moment…',
  away: 'Click or tap this window to continue.',
  mouse: 'Move your mouse to continue.',
  touch: 'Tap the screen once to continue.',
  keyboard: (button: string) => `Press Tab to reach ${button}. Pause there before pressing Enter.`,
});

/** A blur shorter than this changes nothing on screen (a quick focus change doesn't flicker the line). */
export const AWAY_MS = 400;

export interface GuardHintDeps {
  d: Dom;
  /** The page's clock, the guard's. */
  now: () => number;
  /** When the window had focus at load (the guard's own start), else null. */
  focusedAtStart: number | null;
  /** The device's main pointer is coarse (a touch screen): the first words before any input is seen. */
  coarse: boolean;
  /** The element id the guarded buttons point at (`aria-describedby`). */
  id: string;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** The device's main pointer is coarse, by the page's media query; false when it can't be read. */
export function coarsePointer(win: { matchMedia?: (q: string) => { matches: boolean } }): boolean {
  try {
    return typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/** The input an event the guard reads came from: a touch or pen, a mouse, or the keyboard; null when unknown. */
export function inputKind(input: GuardInput): HintInput | null {
  if (input.type === 'keydown') return 'keyboard';
  if (input.pointerType === 'touch' || input.pointerType === 'pen') return 'touch';
  return input.pointerType === 'mouse' ? 'mouse' : null;
}

export class GuardHint {
  readonly el: HTMLElement;
  private renderedAt: number | null = null;
  private focusedAt: number | null;
  private armedNow = false;
  private activeNow = false;
  private seen: HintInput | null = null;
  private away = false;
  private button = 'the button';
  private waitTimer: unknown = null;
  private awayTimer: unknown = null;
  private readonly setTimer: (f: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: GuardHintDeps) {
    this.el = deps.d.h('p', { class: 'guard-hint muted', attrs: { id: deps.id } });
    this.focusedAt = deps.focusedAtStart;
    // A window that starts without focus says to come back at once (no earlier line to keep).
    this.away = deps.focusedAtStart === null;
    this.setTimer = deps.setTimer ?? ((f, ms) => setTimeout(f, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A guarded button: it names the hint for screen readers. `label` is its name in the keyboard line. */
  describe(button: HTMLButtonElement, label: string): void {
    button.setAttribute('aria-describedby', this.deps.id);
    this.button = label;
  }

  /** A new screen (the guard's `rendered`). `active`: whether it has a button the guard holds that is otherwise ready. */
  rendered(active: boolean): void {
    this.renderedAt = this.deps.now();
    this.armedNow = false;
    this.activeNow = active;
    this.update();
  }

  /** Whether a guarded button is otherwise ready (a typed confirmation, a ticked box): only then is there a hint. */
  active(on: boolean): void {
    this.activeNow = on;
    this.update();
  }

  /** The window gained focus or became visible (the guard's `focused`). */
  focused(): void {
    this.focusedAt = this.deps.now();
    this.armedNow = false;
    const quick = this.awayTimer !== null;
    if (this.awayTimer !== null) this.clearTimer(this.awayTimer);
    this.awayTimer = null;
    this.away = false;
    // Back within AWAY_MS: the line stays as it was (no flicker); its words are true again once the wait ends.
    this.update(quick);
  }

  /** The window lost focus or was hidden (the guard's `blurred`): the line changes only if it lasts AWAY_MS. */
  blurred(): void {
    this.focusedAt = null;
    this.armedNow = false;
    if (this.awayTimer !== null) return;
    this.awayTimer = this.setTimer(() => {
      this.awayTimer = null;
      this.away = true;
      this.update();
    }, AWAY_MS);
  }

  /** Nothing to answer (the guard's `cleared`). */
  cleared(): void {
    this.renderedAt = null;
    this.armedNow = false;
    this.activeNow = false;
    this.update();
  }

  /** An input in the window (what the guard was given): its kind picks the words. */
  input(input: GuardInput): void {
    const kind = inputKind(input);
    if (kind === null || kind === this.seen) return;
    this.seen = kind;
    this.update(true);
  }

  /** The guard enabled or disabled its buttons. */
  armed(on: boolean): void {
    this.armedNow = on;
    this.update();
  }

  /** The words for now ('' for none). */
  text(): string {
    if (this.renderedAt === null || !this.activeNow || this.armedNow) return '';
    if (this.focusedAt === null) return this.away ? GUARD_HINT_TEXT.away : this.el.textContent ?? '';
    if (this.deps.now() < this.waitEnd()) return GUARD_HINT_TEXT.wait;
    return this.actionText();
  }

  private actionText(): string {
    const kind = this.seen ?? (this.deps.coarse ? 'touch' : 'mouse');
    return kind === 'keyboard' ? GUARD_HINT_TEXT.keyboard(this.button) : GUARD_HINT_TEXT[kind];
  }

  private waitEnd(): number {
    return Math.max(this.renderedAt ?? 0, this.focusedAt ?? 0) + GUARD_DELAY_MS;
  }

  /** Brings the line up to date; `keepAction`: during a wait, an action line already shown stays (no flicker). */
  private update(keepAction = false): void {
    if (this.waitTimer !== null) this.clearTimer(this.waitTimer);
    this.waitTimer = null;
    let next = this.text();
    const shown = this.el.textContent ?? '';
    if (keepAction && next === GUARD_HINT_TEXT.wait && shown !== '' && shown !== GUARD_HINT_TEXT.wait && shown !== GUARD_HINT_TEXT.away) next = this.actionText();
    if (next === GUARD_HINT_TEXT.wait || (keepAction && this.focusedAt !== null && this.deps.now() < this.waitEnd())) {
      this.waitTimer = this.setTimer(() => {
        this.waitTimer = null;
        this.update();
      }, Math.max(0, this.waitEnd() - this.deps.now()));
    }
    if (shown !== next) this.el.textContent = next;
  }
}
