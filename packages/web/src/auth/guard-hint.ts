// The line under a guarded button (D878): while the Approve guard (approve-guard.ts, D36, D113) holds Approve, Allow,
// Share email, Continue, Show key or Copy key off, one short plain line says why it is off and what turns it on, in
// words that describe the button (they never tell the user to go on). It goes when the button turns on. Display only:
// it never reads or changes the guard. The page tells it what it tells the guard, always after the guard and inside a
// try/catch (a mistake here can never skip a guard call), and the hint keeps its own copy of the guard's two 1 s marks
// and of the keyboard dwell only to choose its words. A wrong guess here changes a sentence, never what a press does.
//
// What it says ({B}: the button's name as it reads now, "Approve", "Hide key"; two names when two buttons are held):
// - for the guard's first GUARD_DELAY_MS after a new screen or after the window gains focus: "One moment…" (nothing
//   turns the button on yet, so no action line shows then);
// - then, by the input last seen (before any, the device's main pointer: a touch screen or a mouse):
//   mouse "{B} turns on when you move your mouse." (only a move arms; a click in place never does);
//   touch "{B} turns on after one tap on the screen." (after the wait one tap anywhere arms, and that tap never
//   approves);
//   keyboard "{B} turns on when you press Tab. Wait a moment on it before pressing Enter." (Tab arms; a keyboard press
//   acts only after the button has held focus for KEYBOARD_DWELL_MS). Only real keyboard use switches to it: Tab, an
//   arrow key, Enter or Space, not composed, not in a text field (a phone's on-screen keyboard typing the confirmation
//   word is not keyboard use);
// - once on, an Enter or Space on the button before it has held focus for KEYBOARD_DWELL_MS does nothing: then
//   "Enter works on {B} after a moment." for a few seconds (or until focus leaves it);
// - while the window has no focus, after AWAY_MS: "{B} is off while this window isn't in front." (a shorter blur keeps
//   the line as it was, so a focus bounce doesn't flicker it; on focus it says "One moment…" for the guard's second);
// - nothing while the button is on, while there is nothing to answer, or while the button is held back for another
//   reason (the page says so through `active`).
// It is a plain paragraph: not a button, not focusable, not a live region (the guard resets on every focus change, so
// announcing each change would repeat itself); the guarded buttons name it in `aria-describedby`. Its space is that of
// its longest sentence (ui.ts `reservedLine`), so nothing moves when it appears, changes or goes.
import { GUARD_DELAY_MS, type GuardInput, KEYBOARD_DWELL_MS } from './approve-guard.ts';
import type { Dom } from './dom.ts';
import { type ReservedLine, reservedLine } from './ui.ts';

export type HintInput = 'mouse' | 'touch' | 'keyboard';

/** "Approve", "Show key and Copy key": the subject of a line, with its verb's form. */
const subject = (names: readonly string[]) => ({ who: names.join(' and '), many: names.length > 1 });

/** The hint's words (D878, plain per D853). */
export const GUARD_HINT_TEXT = Object.freeze({
  wait: 'One moment…',
  away: (names: readonly string[]) => {
    const s = subject(names);
    return `${s.who} ${s.many ? 'are' : 'is'} off while this window isn’t in front.`;
  },
  mouse: (names: readonly string[]) => {
    const s = subject(names);
    return `${s.who} ${s.many ? 'turn' : 'turns'} on when you move your mouse.`;
  },
  touch: (names: readonly string[]) => {
    const s = subject(names);
    return `${s.who} ${s.many ? 'turn' : 'turns'} on after one tap on the screen.`;
  },
  keyboard: (names: readonly string[]) => {
    const s = subject(names);
    return `${s.who} ${s.many ? 'turn' : 'turns'} on when you press Tab. Wait a moment on ${s.many ? 'one' : 'it'} before pressing Enter.`;
  },
  dwell: (name: string) => `Enter works on ${name} after a moment.`,
});

/** A blur shorter than this changes nothing on screen (a quick focus change doesn't flicker the line). */
export const AWAY_MS = 400;
/** How long the line says that Enter works after a moment (or until focus leaves the button). */
export const DWELL_NOTE_MS = 3000;

/** The keys that count as keyboard use: those that move focus or press a button. */
const KEYBOARD_KEYS: ReadonlySet<string> = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ']);

export interface GuardHintDeps {
  d: Dom;
  /** The page's clock, the guard's. */
  now: () => number;
  /** When the window had focus at load (the guard's own start), else null. */
  focusedAtStart: number | null;
  /** The device's main pointer is coarse (a touch screen): the first words before any input is seen. */
  coarse: boolean;
  /** The id of the line the guarded buttons point at (`aria-describedby`). */
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

/** A key typed into a text field (a confirmation word, on a phone's on-screen keyboard too): not keyboard use. */
function inTextField(target: unknown): boolean {
  const el = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || el.isContentEditable === true) return true;
  return tag === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(String(el.type ?? 'text').toLowerCase());
}

/**
 * The input an event the guard reads came from: a touch or pen, a mouse, or the keyboard (only Tab, an arrow key,
 * Enter or Space, not composed, not in a text field); null when unknown or not counted. `e` is the event itself.
 */
export function inputKind(input: GuardInput, e?: Event): HintInput | null {
  if (input.type === 'keydown') {
    const k = e as Partial<KeyboardEvent> | undefined;
    if (!input.key || !KEYBOARD_KEYS.has(input.key) || k?.isComposing === true || inTextField(k?.target)) return null;
    return 'keyboard';
  }
  if (input.pointerType === 'touch' || input.pointerType === 'pen') return 'touch';
  return input.pointerType === 'mouse' ? 'mouse' : null;
}

/**
 * Runs a call into the hint so that nothing it throws reaches the page: the page always calls the guard first, then
 * the hint through this, so a mistake in display-only code can never skip or undo a guard call.
 */
export function quietly(f: () => void): void {
  try {
    f();
  } catch {
    // Display only: the line may be stale; the guard is unaffected.
  }
}

export class GuardHint {
  /** The line and its kept space: placed by the page right under the guarded buttons. */
  readonly el: HTMLElement;
  /** The visible line (`p.guard-hint`, the buttons' `aria-describedby`). */
  readonly line: HTMLElement;
  private readonly reserved: ReservedLine;
  private renderedAt: number | null = null;
  private focusedAt: number | null;
  private armedNow = false;
  private activeNow = false;
  private seen: HintInput | null = null;
  private away: boolean;
  private buttons: HTMLButtonElement[] = [];
  /** When each guarded button last gained focus (the guard's keyboard dwell, mirrored). */
  private readonly focusAt = new Map<HTMLButtonElement, number>();
  private dwellFor: HTMLButtonElement | null = null;
  private waitTimer: unknown = null;
  private awayTimer: unknown = null;
  private dwellTimer: unknown = null;
  private readonly setTimer: (f: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: GuardHintDeps) {
    this.line = deps.d.h('p', { class: 'guard-hint muted', attrs: { id: deps.id } });
    this.reserved = reservedLine(deps.d, this.line, 'guard-hint-box');
    this.el = this.reserved.box;
    this.focusedAt = deps.focusedAtStart;
    // A window that starts without focus says so at once (no earlier line to keep).
    this.away = deps.focusedAtStart === null;
    this.setTimer = deps.setTimer ?? ((f, ms) => setTimeout(f, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A guarded button: it names the line for screen readers, and its name (read as it is at each change) is in it. */
  describe(button: HTMLButtonElement): void {
    button.setAttribute('aria-describedby', this.deps.id);
    if (!this.buttons.includes(button)) this.buttons.push(button);
    button.addEventListener('focus', () => this.focusAt.set(button, this.deps.now()));
    button.addEventListener('blur', () => {
      this.focusAt.delete(button);
      if (this.dwellFor === button) this.endDwell();
    });
  }

  /** A new screen (after the guard's `rendered`). `active`: whether it has a button the guard holds that is otherwise ready. */
  rendered(active: boolean): void {
    this.renderedAt = this.deps.now();
    this.armedNow = false;
    this.activeNow = active;
    this.endDwell(false);
    this.update();
  }

  /** Whether a guarded button is otherwise ready (a typed confirmation, a ticked box): only then is there a line. */
  active(on: boolean): void {
    if (on === this.activeNow) return;
    this.activeNow = on;
    this.update();
  }

  /** The window gained focus or became visible (after the guard's `focused`). */
  focused(): void {
    this.focusedAt = this.deps.now();
    this.armedNow = false;
    if (this.awayTimer !== null) this.clearTimer(this.awayTimer);
    this.awayTimer = null;
    this.away = false;
    this.update();
  }

  /** The window lost focus or was hidden (after the guard's `blurred`): the line changes only if it lasts AWAY_MS. */
  blurred(): void {
    this.focusedAt = null;
    this.armedNow = false;
    this.endDwell(false);
    if (this.awayTimer === null)
      this.awayTimer = this.setTimer(() => {
        this.awayTimer = null;
        this.away = true;
        this.update();
      }, AWAY_MS);
    this.update();
  }

  /** Nothing to answer (after the guard's `cleared`). */
  cleared(): void {
    this.renderedAt = null;
    this.armedNow = false;
    this.activeNow = false;
    this.endDwell(false);
    this.update();
  }

  /**
   * An input in the window (what the guard was given, after it): its kind picks the words; an Enter or Space on a
   * guarded button that hasn't held focus for KEYBOARD_DWELL_MS yet gets the dwell line. `e`: the event itself.
   */
  input(input: GuardInput, e?: Event): void {
    const kind = inputKind(input, e);
    if (kind !== null) this.seen = kind;
    if (kind === 'keyboard' && input.type === 'keydown' && input.repeat !== true && (input.key === 'Enter' || input.key === ' ')) {
      const target = e?.target as HTMLButtonElement | undefined;
      const at = target ? this.focusAt.get(target) : undefined;
      if (target && at !== undefined && this.armedNow && this.deps.now() < at + KEYBOARD_DWELL_MS) {
        this.dwellFor = target;
        if (this.dwellTimer !== null) this.clearTimer(this.dwellTimer);
        this.dwellTimer = this.setTimer(() => this.endDwell(), DWELL_NOTE_MS);
      }
    }
    this.update();
  }

  /** The guard turned its buttons on or off. Off is only noted: the page's next call (after the guard's) shows it. */
  armed(on: boolean): void {
    this.armedNow = on;
    if (on) this.update();
  }

  /** The words for now ('' for none). */
  text(): string {
    if (this.renderedAt === null || !this.activeNow) return '';
    if (this.dwellFor) return GUARD_HINT_TEXT.dwell(this.nameOf(this.dwellFor));
    if (this.armedNow) return '';
    if (this.focusedAt === null) return this.away ? GUARD_HINT_TEXT.away(this.names()) : (this.line.textContent ?? '');
    if (this.deps.now() < this.waitEnd()) return GUARD_HINT_TEXT.wait;
    const kind = this.seen ?? (this.deps.coarse ? 'touch' : 'mouse');
    return GUARD_HINT_TEXT[kind](this.names());
  }

  private nameOf(b: HTMLButtonElement): string {
    return (b.textContent ?? '').trim() || 'The button';
  }

  /** The names of the guarded buttons on screen now, as they read now. */
  private names(): string[] {
    const on = this.buttons.filter((b) => b.isConnected);
    const list = (on.length > 0 ? on : this.buttons.slice(-1)).map((b) => this.nameOf(b));
    return list.length > 0 ? [...new Set(list)] : ['The button'];
  }

  private waitEnd(): number {
    return Math.max(this.renderedAt ?? 0, this.focusedAt ?? 0) + GUARD_DELAY_MS;
  }

  private endDwell(refresh = true): void {
    if (this.dwellTimer !== null) this.clearTimer(this.dwellTimer);
    this.dwellTimer = null;
    this.dwellFor = null;
    if (refresh) this.update();
  }

  /** Brings the line up to date, its kept space to its possible sentences, and a timer to the wait's end. */
  private update(): void {
    if (this.waitTimer !== null) this.clearTimer(this.waitTimer);
    this.waitTimer = null;
    const names = this.names();
    this.reserved.sizes([GUARD_HINT_TEXT.wait, GUARD_HINT_TEXT.away(names), GUARD_HINT_TEXT.mouse(names), GUARD_HINT_TEXT.touch(names), GUARD_HINT_TEXT.keyboard(names), ...names.map((n) => GUARD_HINT_TEXT.dwell(n))]);
    const next = this.text();
    if (next === GUARD_HINT_TEXT.wait) {
      this.waitTimer = this.setTimer(
        () => {
          this.waitTimer = null;
          this.update();
        },
        Math.max(0, this.waitEnd() - this.deps.now()),
      );
    }
    if ((this.line.textContent ?? '') !== next) this.line.textContent = next;
  }
}
