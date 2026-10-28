// The Approve guard (docs/batch-b-spec.md "Approval flow" step 5; the per-input rule is a user decision of
// 2026-10-28, docs/decisions.md). Approve (and Allow on the consent screen) stays disabled until all of these have
// happened: at least 1 s since this request rendered, at least 1 s since the window last gained focus or became
// visible, and an arming gesture inside the window after both. A new request in a reused popup, a focus change and a
// blur or hide reset it. This stops a double-click carried across the launcher→popup opening, and a request slipped
// in at the moment of a click.
//
// What arms it depends on the input:
// - mouse: only a `pointermove` that moved (a press never arms; Chromium's synthetic moves after a layout change carry
//   zero movement and are ignored). So clicking in place, however often, never approves. A move counts as moved when
//   its movementX/Y is non-zero, or, when both are 0 (WebKit reports 0 on every pointermove), when BOTH its client
//   position and its screen position differ from the last pointer event's, recorded within the current request and
//   focus period (any reset of the guard forgets it). A real cursor move changes both; a layout change under a still
//   cursor changes neither; a window move changes only the screen position. Missing or non-finite coordinates, or no
//   recorded position yet, never arm.
// - touch and pen: a `pointerdown` (a stationary tap fires no pointermove), or a move.
// - keyboard: only Tab, Shift+Tab and the arrow keys, the keys that move focus. Enter and Space never arm, and a
//   key's auto-repeat never counts, so a held Enter never approves.
// The gesture that arms it never approves: Approve acts only on a click whose own pointerdown (or, for a keyboard
// click, its own non-repeated keydown) came after the arming gesture. So a tap that lands on the button as it enables
// does nothing and only the next tap approves. Approve is never focused by the page: a keyboard user reaches it with
// Tab, which arms the guard on the way.
//
// Residual risk (accepted): on a phone, someone tapping repeatedly for more than 1 s after the popup tab opens can
// still approve in two taps, if the second lands on Approve.

export const GUARD_DELAY_MS = 1000;

/** Keys that arm the guard (they move focus; none of them activates a button). */
export const ARMING_KEYS: ReadonlySet<string> = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** The parts of a pointer or keyboard event the guard reads (absent fields are treated strictly). */
export type GuardInput =
  | { type: 'pointermove'; pointerType?: string; movementX?: number; movementY?: number } & Coords
  | ({ type: 'pointerdown'; pointerType?: string } & Coords)
  | { type: 'keydown'; key?: string; repeat?: boolean };

/** A pointer event's client and screen coordinates, as the page read them. */
export interface Coords {
  clientX?: number;
  clientY?: number;
  screenX?: number;
  screenY?: number;
}

type Point = { cx: number; cy: number; sx: number; sy: number };

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** All four coordinates, or null when any is missing or not finite. */
const pointOf = (c: Coords): Point | null =>
  finite(c.clientX) && finite(c.clientY) && finite(c.screenX) && finite(c.screenY) ? { cx: c.clientX, cy: c.clientY, sx: c.screenX, sy: c.screenY } : null;

/** The cursor really moved: both the client and the screen position changed. */
const moved = (p: Point, last: Point): boolean => (p.cx !== last.cx || p.cy !== last.cy) && (p.sx !== last.sx || p.sy !== last.sy);

/** Whether this input, after both marks, arms the guard. `lastPoint` is the previous pointer event's position. */
function arms(input: GuardInput, lastPoint: Point | null): boolean {
  switch (input.type) {
    case 'pointermove': {
      if (input.pointerType === 'touch' || input.pointerType === 'pen') return true;
      if (!(input.movementX === 0 && input.movementY === 0)) return true;
      // Zero movement: a synthetic move under a still cursor (layout change), or WebKit, which reports 0 for every
      // move. Only a move whose client and screen positions both changed since the last pointer event (of this request
      // and focus period) counts; with no known position, or incomplete coordinates, it doesn't.
      const p = pointOf(input);
      return p !== null && lastPoint !== null && moved(p, lastPoint);
    }
    case 'pointerdown':
      return input.pointerType === 'touch' || input.pointerType === 'pen';
    case 'keydown':
      return input.repeat !== true && input.key !== undefined && ARMING_KEYS.has(input.key);
  }
}

export class ApproveGuard {
  private renderedAt: number | null = null;
  private focusedAt: number | null;
  /** Sequence number of the gesture that armed the guard (null: not armed). */
  private armedBy: number | null = null;
  /** Gesture sequence: every gesture gets the next number, so "after" is exact even within one millisecond. */
  private seq = 0;
  private lastPointerDown = 0;
  private lastKeyDown = 0;
  /**
   * The position of the last pointer event (move or press) in the current request and focus period, for moves that
   * report zero movement. Every reset of the guard forgets it.
   */
  private lastPoint: Point | null = null;
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
    this.lastPoint = null;
    this.update();
  }

  /** The window gained focus or became visible. */
  focused(): void {
    this.focusedAt = this.now();
    this.armedBy = null;
    this.lastPoint = null;
    this.update();
  }

  /** The window lost focus or was hidden: disarmed until it is focused again. */
  blurred(): void {
    this.focusedAt = null;
    this.armedBy = null;
    this.lastPoint = null;
    this.update();
  }

  /** Nothing to approve (waiting for the next request). */
  cleared(): void {
    this.renderedAt = null;
    this.armedBy = null;
    this.lastPoint = null;
    this.update();
  }

  /**
   * A trusted pointer or key event anywhere in the window (including on the disabled button). It arms the guard only
   * if it is an arming input (see the file comment) and both 1 s marks have passed; a pointerdown or a non-repeated
   * keydown is also remembered as the start of a possible activation.
   */
  gesture(input: GuardInput): void {
    if (input.type === 'keydown' && input.repeat === true) return;
    const n = ++this.seq;
    if (input.type === 'pointerdown') this.lastPointerDown = n;
    if (input.type === 'keydown') this.lastKeyDown = n;
    const arming = arms(input, this.lastPoint);
    // An event with incomplete coordinates forgets the position: the next zero-movement move has nothing to compare with.
    if (input.type !== 'keydown') this.lastPoint = pointOf(input);
    if (this.armedBy === null && arming && this.marksPassed(this.now())) this.armedBy = n;
    this.update();
  }

  /** Whether Approve is enabled (both marks passed and an arming gesture after them). */
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
