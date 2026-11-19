// @vitest-environment happy-dom
// The line under a guarded button (D878, guard-hint.ts): what it says in each state and for each input, that each line
// is true when it shows, that it is display only, and that the guard it describes is the one D36 and D113 decided,
// unchanged.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS, KEYBOARD_DWELL_MS } from '../../src/auth/approve-guard.ts';
import { dom } from '../../src/auth/dom.ts';
import { AWAY_MS, DWELL_NOTE_MS, GUARD_HINT_TEXT, GuardHint, coarsePointer, inputKind, quietly } from '../../src/auth/guard-hint.ts';

const T0 = 1_800_000_000_000;
const mouseMove = { type: 'pointermove', pointerType: 'mouse', movementX: 1, movementY: 0, clientX: 1, clientY: 1 } as const;
const touchDown = { type: 'pointerdown', pointerType: 'touch', clientX: 5, clientY: 5 } as const;
const key = (k: string) => ({ type: 'keydown', key: k, repeat: false }) as const;
const A = ['Approve'];

let hint: GuardHint;
let approve: HTMLButtonElement;
const make = (coarse = false, focusedAtStart: number | null = T0) => {
  hint = new GuardHint({ d: dom(document), now: () => Date.now(), focusedAtStart, coarse, id: 'guard-hint' });
  approve = document.createElement('button');
  approve.textContent = 'Approve';
  document.body.replaceChildren(approve, hint.el);
  hint.describe(approve);
  return hint;
};
const text = () => hint.line.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('the guard hint’s words (D878)', () => {
  it('the exact sentences', () => {
    expect(GUARD_HINT_TEXT.wait).toBe('One moment…');
    expect(GUARD_HINT_TEXT.mouse(A)).toBe('Approve turns on when you move your mouse.');
    expect(GUARD_HINT_TEXT.touch(A)).toBe('Approve turns on after one tap on the screen.');
    expect(GUARD_HINT_TEXT.keyboard(A)).toBe('Approve turns on when you press Tab. Wait a moment on it before pressing Enter.');
    expect(GUARD_HINT_TEXT.away(A)).toBe('Approve is off while this window isn’t in front.');
    expect(GUARD_HINT_TEXT.dwell('Approve')).toBe('Enter works on Approve after a moment.');
    // Two held buttons (the export window's Show key and Copy key).
    expect(GUARD_HINT_TEXT.mouse(['Show key', 'Copy key'])).toBe('Show key and Copy key turn on when you move your mouse.');
    expect(GUARD_HINT_TEXT.keyboard(['Show key', 'Copy key'])).toBe('Show key and Copy key turn on when you press Tab. Wait a moment on one before pressing Enter.');
    expect(GUARD_HINT_TEXT.away(['Show key', 'Copy key'])).toBe('Show key and Copy key are off while this window isn’t in front.');
    // They describe the button; none tells the user to go on.
    for (const t of [GUARD_HINT_TEXT.mouse(A), GUARD_HINT_TEXT.touch(A), GUARD_HINT_TEXT.keyboard(A), GUARD_HINT_TEXT.away(A), GUARD_HINT_TEXT.dwell('Approve')]) expect(t).not.toMatch(/continue/iu);
  });

  it('a new screen: “One moment…” for the guard’s 1 s, then the mouse line; gone once the button turns on', () => {
    make().rendered(true);
    expect(text()).toBe('One moment…');
    vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
    expect(text()).toBe('One moment…');
    vi.advanceTimersByTime(1);
    expect(text()).toBe('Approve turns on when you move your mouse.');
    hint.armed(true);
    expect(text()).toBe('');
  });

  it('the button’s name as it reads now (Show key becomes Hide key)', () => {
    make().rendered(true);
    approve.textContent = 'Hide key';
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe('Hide key turns on when you move your mouse.');
  });

  it('a touch screen (coarse pointer) before any input: the tap line; a tap seen switches to it', () => {
    make(true).rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe('Approve turns on after one tap on the screen.');
    make(false).rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    hint.input(touchDown);
    expect(text()).toBe(GUARD_HINT_TEXT.touch(A));
  });

  it('the keyboard line only on real keyboard use: Tab, arrows, Enter, Space; not letters, IME, Unidentified or a text field', () => {
    make().rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    const field = document.createElement('input');
    document.body.append(field);
    const ev = (k: string, target: EventTarget, more: Record<string, unknown> = {}) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, ...more });
      target.dispatchEvent(e);
      return e;
    };
    for (const [k, target, more] of [['a', document.body, {}], ['Unidentified', document.body, {}], ['Process', document.body, {}], ['Enter', document.body, { isComposing: true }], ['Enter', field, {}], ['Tab', field, {}]] as const) {
      hint.input(key(k), ev(k, target, more));
      expect(text(), `${k}`).toBe(GUARD_HINT_TEXT.mouse(A));
    }
    expect(inputKind(key('a'))).toBeNull();
    hint.input(key('Tab'), ev('Tab', document.body));
    expect(text()).toBe('Approve turns on when you press Tab. Wait a moment on it before pressing Enter.');
    hint.input(mouseMove);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse(A));
    hint.input(key(' '), ev(' ', document.body));
    expect(text()).toBe(GUARD_HINT_TEXT.keyboard(A));
  });

  it('no action line during the guard’s second: an input seen then, or a focus change, shows “One moment…”', () => {
    make().rendered(true);
    hint.input(key('Tab'), new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.keyboard(A));
    // A short blur keeps the line (no flicker), and the focus that ends it starts the guard's second again.
    hint.blurred();
    vi.advanceTimersByTime(AWAY_MS - 1);
    expect(text()).toBe(GUARD_HINT_TEXT.keyboard(A));
    hint.focused();
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.keyboard(A));
  });

  it('a longer blur says the button is off while the window isn’t in front; focus, the wait, then the action', () => {
    make().rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    hint.blurred();
    vi.advanceTimersByTime(AWAY_MS);
    expect(text()).toBe('Approve is off while this window isn’t in front.');
    hint.focused();
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse(A));
  });

  it('on, then blurred: the line stays empty (the guard turned it off first; the hint keeps what it showed)', () => {
    make().rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    hint.armed(true);
    expect(text()).toBe('');
    // The page calls the guard first: its "off" is noted, then the blur.
    hint.armed(false);
    hint.blurred();
    expect(text()).toBe('');
  });

  it('a window opened without focus says so at once; focus, the wait, then the action', () => {
    make(false, null).rendered(true);
    expect(text()).toBe(GUARD_HINT_TEXT.away(A));
    hint.focused();
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse(A));
  });

  it('the keyboard dwell: an Enter on the button before it held focus for the dwell gets its line, then it goes', () => {
    make().rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    hint.armed(true);
    approve.dispatchEvent(new FocusEvent('focus'));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    approve.dispatchEvent(enter);
    hint.input(key('Enter'), enter);
    expect(text()).toBe('Enter works on Approve after a moment.');
    vi.advanceTimersByTime(DWELL_NOTE_MS);
    expect(text()).toBe('');
    // After the dwell, Enter works: no line.
    vi.advanceTimersByTime(KEYBOARD_DWELL_MS);
    hint.input(key('Enter'), enter);
    expect(text()).toBe('');
    // Leaving the button ends the line at once.
    approve.dispatchEvent(new FocusEvent('blur'));
    approve.dispatchEvent(new FocusEvent('focus'));
    hint.input(key('Enter'), enter);
    expect(text()).toBe(GUARD_HINT_TEXT.dwell('Approve'));
    approve.dispatchEvent(new FocusEvent('blur'));
    expect(text()).toBe('');
  });

  it('nothing to say: nothing to answer, no guarded button on the screen, or one held back for another reason', () => {
    make().rendered(false);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe('');
    hint.active(true);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse(A));
    hint.active(false);
    expect(text()).toBe('');
    hint.active(true);
    hint.cleared();
    expect(text()).toBe('');
    vi.advanceTimersByTime(GUARD_DELAY_MS * 5);
    expect(text()).toBe('');
  });

  it('display only: a plain paragraph, not focusable, not a live region; its kept space holds hidden copies of every sentence', () => {
    make().rendered(true);
    expect(hint.line.tagName).toBe('P');
    expect(hint.line.id).toBe('guard-hint');
    expect(approve.getAttribute('aria-describedby')).toBe('guard-hint');
    for (const el of [hint.el, hint.line]) {
      expect(el.hasAttribute('tabindex')).toBe(false);
      expect(el.hasAttribute('role')).toBe(false);
      expect(el.hasAttribute('aria-live')).toBe(false);
    }
    const sizers = [...hint.el.querySelectorAll(':scope > .sizer')];
    expect(sizers.map((s) => s.textContent)).toEqual([GUARD_HINT_TEXT.wait, GUARD_HINT_TEXT.away(A), GUARD_HINT_TEXT.mouse(A), GUARD_HINT_TEXT.touch(A), GUARD_HINT_TEXT.keyboard(A), GUARD_HINT_TEXT.dwell('Approve')]);
    for (const s of sizers) expect(s.getAttribute('aria-hidden')).toBe('true');
    expect(hint.el.className).toBe('reserved guard-hint-box');
  });

  it('the input of an event; the device’s pointer; quietly swallows a throw', () => {
    expect(inputKind(touchDown)).toBe('touch');
    expect(inputKind({ type: 'pointermove', pointerType: 'pen' })).toBe('touch');
    expect(inputKind(mouseMove)).toBe('mouse');
    expect(inputKind(key('Tab'))).toBe('keyboard');
    expect(inputKind({ type: 'pointerdown' })).toBeNull();
    expect(coarsePointer({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(coarsePointer({})).toBe(false);
    expect(coarsePointer({ matchMedia: () => { throw new Error('no'); } })).toBe(false);
    expect(() => quietly(() => { throw new Error('display'); })).not.toThrow();
  });

  it('the kept space: every line and its hidden copies share one grid cell (base.css .reserved)', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'auth', 'css', 'base.css'), 'utf8');
    expect(css).toMatch(/\.reserved \{\s*display: grid;\s*\}/u);
    expect(css).toMatch(/\.reserved > \* \{\s*grid-area: 1 \/ 1;/u);
    expect(css).toMatch(/\.reserved > \.sizer \{\s*visibility: hidden;\s*\}/u);
  });
});

describe('the guard itself is unchanged by D878', () => {
  it('approve-guard.ts is byte for byte the file D36 and D113 shaped (a change to it is a guard change: its own decision)', () => {
    const file = readFileSync(join(process.cwd(), 'src', 'auth', 'approve-guard.ts'));
    expect(createHash('sha256').update(file).digest('hex')).toBe('7a7cc551c823d4ac3c5db10a6627d41aec4c932d63c3306beace0b9330f9a242');
  });
});
