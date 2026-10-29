// The Approve guard's zero-movement fallback (src/auth/approve-guard.ts; docs/decisions.md D36, amended 2026-10-28):
// WebKit reports movementX/Y = 0 on every pointermove, so such a move arms only when its client position changed
// against the last pointer event recorded in the current request and focus period. Screen coordinates are ignored
// (WebKit on Linux reports them as fixed).
import { describe, expect, it } from 'vitest';
import { ApproveGuard, type Coords, GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';

/** A guard past both 1 s marks (rendered and focused at 0, now 1 s later), on a controllable clock. */
function ready(): { guard: ApproveGuard; clock: { t: number } } {
  const clock = { t: 0 };
  const guard = new ApproveGuard(() => clock.t, 0);
  guard.rendered();
  clock.t = GUARD_DELAY_MS;
  return { guard, clock };
}

const at = (x: number, y: number): Coords => ({ clientX: x, clientY: y });
const move = (c: Coords) => ({ type: 'pointermove' as const, pointerType: 'mouse', movementX: 0, movementY: 0, ...c });
const press = (c: Coords) => ({ type: 'pointerdown' as const, pointerType: 'mouse', ...c });

describe('ApproveGuard: zero-movement mouse moves', () => {
  it('arms when the client position changed (the WebKit case)', () => {
    const { guard } = ready();
    guard.gesture(move(at(5, 5)));
    expect(guard.armed()).toBe(false);
    guard.gesture(move(at(16, 16)));
    expect(guard.armed()).toBe(true);
  });

  it('arms although screen coordinates stay fixed (WebKit on Linux)', () => {
    const { guard } = ready();
    guard.gesture(move({ ...at(5, 5), screenX: 0, screenY: 0 } as Coords));
    guard.gesture(move({ ...at(16, 16), screenX: 0, screenY: 0 } as Coords));
    expect(guard.armed()).toBe(true);
  });

  it('does not arm when only the screen position changed (the client position is the same)', () => {
    const { guard } = ready();
    guard.gesture(move({ ...at(5, 5), screenX: 400, screenY: 400 } as Coords));
    guard.gesture(move({ ...at(5, 5), screenX: 500, screenY: 450 } as Coords));
    expect(guard.armed()).toBe(false);
  });

  it('does not arm on a synthetic move at the same spot, nor after a press there (click-spam in place)', () => {
    const { guard } = ready();
    guard.gesture(move(at(5, 5)));
    for (let i = 0; i < 5; i++) {
      guard.gesture(press(at(5, 5)));
      guard.gesture(move(at(5, 5)));
    }
    expect(guard.armed()).toBe(false);
  });

  it('does not arm with missing or non-finite coordinates, and such an event forgets the position', () => {
    const { guard } = ready();
    guard.gesture(move(at(5, 5)));
    guard.gesture(move({ clientX: 16 }));
    guard.gesture(move({ clientX: Number.NaN, clientY: 17 }));
    expect(guard.armed()).toBe(false);
    // The incomplete events left nothing to compare with: this complete move only records a position.
    guard.gesture(move(at(30, 30)));
    expect(guard.armed()).toBe(false);
    guard.gesture(move(at(31, 31)));
    expect(guard.armed()).toBe(true);
  });

  it.each([
    ['a new request (rendered)', (g: ApproveGuard) => g.rendered()],
    ['a focus (focused)', (g: ApproveGuard) => g.focused()],
    ['a blur and a focus (blurred, focused)', (g: ApproveGuard) => (g.blurred(), g.focused())],
    ['nothing to approve, then a new request (cleared, rendered)', (g: ApproveGuard) => (g.cleared(), g.rendered())],
  ])('a position recorded before %s never arms after it', (_, reset) => {
    const { guard, clock } = ready();
    guard.gesture(move(at(5, 5)));
    reset(guard);
    clock.t += GUARD_DELAY_MS;
    guard.gesture(move(at(40, 40)));
    expect(guard.armed()).toBe(false);
    guard.gesture(move(at(41, 41)));
    expect(guard.armed()).toBe(true);
  });

  it('a move with real movement still arms on its own (Chromium, Firefox)', () => {
    const { guard } = ready();
    guard.gesture({ type: 'pointermove', pointerType: 'mouse', movementX: 3, movementY: 0 });
    expect(guard.armed()).toBe(true);
  });
});
