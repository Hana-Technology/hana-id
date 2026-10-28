// The Approve guard (docs/batch-b-spec.md "Approval flow" step 5). Approve (and Allow on the consent screen) stays
// disabled until all of these have happened: at least 1 s since this request rendered, at least 1 s since the window
// last gained focus or became visible, and a user gesture inside the window after both. A new request in a reused
// popup resets it. This stops a double-click carried across the launcher→popup opening, and a request slipped in
// at the moment of a click.
//
// SPEC DEVIATION (raised for the user to confirm): the spec arms on a `pointermove` only. A stationary touch tap fires
// no pointermove and keyboard activation fires none at all, so on phones (where popups open as tabs) and for
// keyboard-only users Approve would never enable. The guard therefore also arms on a `pointerdown` or `keydown`
// after both marks. The gesture that arms it can never approve: Approve acts only on a click whose own pointerdown
// (or, for a keyboard click, keydown) came after the arming gesture, so a tap that lands on the button as it enables
// does nothing and only the next tap approves. (Every supported browser fires pointer events for touch, so
// `touchstart` is not needed and would double-count a tap.)

export const GUARD_DELAY_MS = 1000;

export type GuardGesture = 'pointermove' | 'pointerdown' | 'keydown';

export class ApproveGuard {
  private renderedAt: number | null = null;
  private focusedAt: number | null;
  /** Sequence number of the gesture that armed the guard (null: not armed). */
  private armedBy: number | null = null;
  /** Gesture sequence: every gesture gets the next number, so "after" is exact even within one millisecond. */
  private seq = 0;
  private lastPointerDown = 0;
  private lastKeyDown = 0;
  private last = false;

  /**
   * @param focusedAtStart when the window had focus and was visible at load (its load time), else null until a
   *   focus or visibility event.
   */
  constructor(
    private readonly now: () => number,
    focusedAtStart: number | null,
    private readonly onChange: (armed: boolean) => void = () => {},
  ) {
    this.focusedAt = focusedAtStart;
  }

  /** A new request (or consent screen) was rendered. */
  rendered(): void {
    this.renderedAt = this.now();
    this.armedBy = null;
    this.update();
  }

  /** The window gained focus or became visible. */
  focused(): void {
    this.focusedAt = this.now();
    this.armedBy = null;
    this.update();
  }

  /** The window lost focus or was hidden: disarmed until it is focused again. */
  blurred(): void {
    this.focusedAt = null;
    this.armedBy = null;
    this.update();
  }

  /** Nothing to approve (waiting for the next request). */
  cleared(): void {
    this.renderedAt = null;
    this.armedBy = null;
    this.update();
  }

  /**
   * A user gesture anywhere in the window (including on the disabled button). It arms the guard only once both 1 s
   * marks have passed; a pointerdown or keydown is also remembered as the start of a possible activation.
   */
  gesture(kind: GuardGesture): void {
    const n = ++this.seq;
    if (kind === 'pointerdown') this.lastPointerDown = n;
    if (kind === 'keydown') this.lastKeyDown = n;
    const t = this.now();
    if (this.armedBy === null && this.marksPassed(t)) this.armedBy = n;
    this.update();
  }

  /** Whether Approve is enabled (both marks passed and a gesture after them). */
  armed(): boolean {
    return this.armedBy !== null && this.marksPassed(this.now());
  }

  /**
   * Whether a click on Approve may act now: armed, and the click's own pointerdown (or keydown, for a click from the
   * keyboard) came after the gesture that armed the guard. Checked on click, not only through `disabled`.
   */
  mayActivate(fromKeyboard: boolean): boolean {
    if (!this.armed() || this.armedBy === null) return false;
    return (fromKeyboard ? this.lastKeyDown : this.lastPointerDown) > this.armedBy;
  }

  private marksPassed(t: number): boolean {
    return this.renderedAt !== null && this.focusedAt !== null && t >= this.renderedAt + GUARD_DELAY_MS && t >= this.focusedAt + GUARD_DELAY_MS;
  }

  private update(): void {
    const armed = this.armed();
    if (armed !== this.last) {
      this.last = armed;
      this.onChange(armed);
    }
  }
}
