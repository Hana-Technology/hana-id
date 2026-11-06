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
//   its movementX/Y is non-zero, or, when both are 0 (WebKit reports 0 on every pointermove), when its client
//   (viewport) position differs from the last pointer event's, recorded within the current request and focus period
//   (any reset of the guard forgets it). A layout change or scroll under a still cursor leaves the client position
//   unchanged, so it never arms; only the cursor moving, or the user moving the window under it, changes it (no other
//   page can move this window). Screen coordinates aren't used: some engines (WebKit on Linux) report them as fixed.
//   Missing or non-finite client coordinates, or no recorded position yet, never arm.
// - touch and pen: a `pointerdown` (a stationary tap fires no pointermove), or a move.
// - keyboard: only Tab, Shift+Tab and the arrow keys, the keys that move focus. Enter and Space never arm, and a
//   key's auto-repeat never counts, so a held Enter never approves.
// The gesture that arms it never approves: Approve acts only on a click whose own pointerdown (or, for a keyboard
// click, its own non-repeated keydown) came after the arming gesture. So a tap that lands on the button as it enables
// does nothing and only the next tap approves. Approve is never focused by the page: a keyboard user reaches it with
// Tab, which arms the guard on the way. A keyboard click also needs Approve to have held focus for KEYBOARD_DWELL_MS
// before its keydown (D113, sweep AUTH-3): "Tab, Tab, Enter" typed in one go, which a partner page could coach a user
// into, lands Enter on Approve too soon and does nothing; the user has to stop on Approve first.
//
// Residual risk (accepted): on a phone, someone tapping repeatedly for more than 1 s after the popup tab opens can
// still approve in two taps, if the second lands on Approve; on a desktop, a user coached to Tab to Approve, wait and
// press Enter still approves (as a user coached to click Approve does).

export const GUARD_DELAY_MS = 1000;
/** How long Approve must hold focus before a keyboard click on it acts (D113). */
export const KEYBOARD_DWELL_MS = 500;

/** Keys that arm the guard (they move focus; none of them activates a button). */
export const ARMING_KEYS: ReadonlySet<string> = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** The parts of a pointer or keyboard event the guard reads (absent fields are treated strictly). */
export type GuardInput =
  | { type: 'pointermove'; pointerType?: string; movementX?: number; movementY?: number } & Coords
  | ({ type: 'pointerdown'; pointerType?: string } & Coords)
  | { type: 'keydown'; key?: string; repeat?: boolean };

/** A pointer event's client (viewport) coordinates, as the page read them. */
export interface Coords {
  clientX?: number;
  clientY?: number;
}

type Point = { cx: number; cy: number };

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Both client coordinates, or null when either is missing or not finite. */
const pointOf = (c: Coords): Point | null => (finite(c.clientX) && finite(c.clientY) ? { cx: c.clientX, cy: c.clientY } : null);

/** The cursor moved within the viewport. */
const moved = (p: Point, last: Point): boolean => p.cx !== last.cx || p.cy !== last.cy;

/** Whether this input, after both marks, arms the guard. `lastPoint` is the previous pointer event's position. */
function arms(input: GuardInput, lastPoint: Point | null): boolean {
  switch (input.type) {
    case 'pointermove': {
      if (input.pointerType === 'touch' || input.pointerType === 'pen') return true;
      if (!(input.movementX === 0 && input.movementY === 0)) return true;
      // Zero movement: a synthetic move under a still cursor (layout change), or WebKit, which reports 0 for every
      // move. Only a move whose client position changed since the last pointer event (of this request and focus
      // period) counts; with no known position, or incomplete coordinates, it doesn't.
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
  /** When the last non-repeated keydown happened (the guard's clock). */
  private lastKeyDownAt = Number.NEGATIVE_INFINITY;
  /** When Approve last gained focus, or null while it doesn't have it. */
  private primaryFocusAt: number | null = null;
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
    this.primaryFocusAt = null;
    this.update();
  }

  /** Approve gained focus (its own `focus` event, also when the window regains focus with Approve focused). */
  primaryFocused(): void {
    this.primaryFocusAt = this.now();
  }

  /** Approve lost focus. */
  primaryBlurred(): void {
    this.primaryFocusAt = null;
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
    this.primaryFocusAt = null;
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
    if (input.type === 'keydown') {
      this.lastKeyDown = n;
      this.lastKeyDownAt = this.now();
    }
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
   * keyboard) came after the gesture that armed the guard; a keyboard click's keydown also came at least
   * KEYBOARD_DWELL_MS after Approve gained focus. Checked on click, not only through `disabled`.
   */
  mayActivate(fromKeyboard: boolean): boolean {
    if (!this.armed() || this.armedBy === null) return false;
    if (!fromKeyboard) return this.lastPointerDown > this.armedBy;
    return this.lastKeyDown > this.armedBy && this.primaryFocusAt !== null && this.lastKeyDownAt >= this.primaryFocusAt + KEYBOARD_DWELL_MS;
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

/** The client coordinates of a pointer event (each only when it is a number). */
function position(o: Partial<PointerEvent>): Coords {
  const out: Coords = {};
  for (const k of ['clientX', 'clientY'] as const) if (typeof o[k] === 'number') out[k] = o[k];
  return out;
}

/** The fields of a pointer or keyboard event the guard reads (approve-guard.ts). */
export function guardInput(type: GuardInput['type'], e: Event): GuardInput {
  const o = e as Partial<PointerEvent & KeyboardEvent>;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const pointerType = str(o.pointerType);
  switch (type) {
    case 'pointermove': {
      const movementX = num(o.movementX);
      const movementY = num(o.movementY);
      return { type, ...(pointerType !== undefined ? { pointerType } : {}), ...(movementX !== undefined ? { movementX } : {}), ...(movementY !== undefined ? { movementY } : {}), ...position(o) };
    }
    case 'pointerdown':
      return { type, ...(pointerType !== undefined ? { pointerType } : {}), ...position(o) };
    case 'keydown': {
      const key = str(o.key);
      return { type, ...(key !== undefined ? { key } : {}), repeat: o.repeat === true };
    }
  }
}
