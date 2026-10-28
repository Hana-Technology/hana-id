// The Approve guard (docs/batch-b-spec.md "Approval flow" step 5). Approve (and Allow on the consent screen) stays
// disabled until all of these have happened: at least 1 s since this request rendered, at least 1 s since the window
// last gained focus or became visible, and a pointermove inside the window after both. A new request in a reused
// popup resets it. This stops a double-click carried across the launcher→popup opening, and a request slipped in
// at the moment of a click.

export const GUARD_DELAY_MS = 1000;

export class ApproveGuard {
  private renderedAt: number | null = null;
  private focusedAt: number | null;
  private movedAt: number | null = null;
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
    this.movedAt = null;
    this.update();
  }

  /** The window gained focus or became visible. */
  focused(): void {
    this.focusedAt = this.now();
    this.movedAt = null;
    this.update();
  }

  /** The window lost focus or was hidden: disarmed until it is focused again. */
  blurred(): void {
    this.focusedAt = null;
    this.movedAt = null;
    this.update();
  }

  /** Nothing to approve (waiting for the next request). */
  cleared(): void {
    this.renderedAt = null;
    this.movedAt = null;
    this.update();
  }

  /** A pointermove inside the window. It counts only once both 1 s marks have passed. */
  pointerMoved(): void {
    const t = this.now();
    if (this.renderedAt !== null && this.focusedAt !== null && t >= this.renderedAt + GUARD_DELAY_MS && t >= this.focusedAt + GUARD_DELAY_MS) this.movedAt = t;
    this.update();
  }

  /** Whether Approve may act now (also checked on click, not only through the disabled attribute). */
  armed(): boolean {
    if (this.renderedAt === null || this.focusedAt === null || this.movedAt === null) return false;
    return this.movedAt >= this.renderedAt + GUARD_DELAY_MS && this.movedAt >= this.focusedAt + GUARD_DELAY_MS;
  }

  private update(): void {
    const armed = this.armed();
    if (armed !== this.last) {
      this.last = armed;
      this.onChange(armed);
    }
  }
}
