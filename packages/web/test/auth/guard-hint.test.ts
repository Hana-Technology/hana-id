// @vitest-environment happy-dom
// The line under a guarded button (D878, guard-hint.ts): what it says in each state and for each input, that it is
// display only, and that the guard it describes is the one D36 and D113 decided, unchanged.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { dom } from '../../src/auth/dom.ts';
import { AWAY_MS, GUARD_HINT_TEXT, GuardHint, coarsePointer, inputKind } from '../../src/auth/guard-hint.ts';

const T0 = 1_800_000_000_000;
const mouseMove = { type: 'pointermove', pointerType: 'mouse', movementX: 1, movementY: 0, clientX: 1, clientY: 1 } as const;
const touchDown = { type: 'pointerdown', pointerType: 'touch', clientX: 5, clientY: 5 } as const;
const tabKey = { type: 'keydown', key: 'Tab', repeat: false } as const;

let hint: GuardHint;
const make = (coarse = false, focusedAtStart: number | null = T0) => {
  hint = new GuardHint({ d: dom(document), now: () => Date.now(), focusedAtStart, coarse, id: 'guard-hint' });
  document.body.replaceChildren(hint.el);
  return hint;
};
const text = () => hint.el.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('the guard hint’s words (D878)', () => {
  it('a new screen: “One moment…” for the guard’s 1 s, then the mouse line; gone once the button enables', () => {
    make().rendered(true);
    expect(text()).toBe('One moment…');
    vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
    expect(text()).toBe('One moment…');
    vi.advanceTimersByTime(1);
    expect(text()).toBe('Move your mouse to continue.');
    hint.armed(true);
    expect(text()).toBe('');
    // Disabled again (a reset): it says so again.
    hint.armed(false);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
  });

  it('a touch screen (coarse pointer) before any input: the tap line; after a tap is seen, the tap line', () => {
    make(true).rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe('Tap the screen once to continue.');
    make(false).rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    hint.input(touchDown);
    expect(text()).toBe(GUARD_HINT_TEXT.touch);
  });

  it('the keyboard: Tab to the named button and pause, as D113 asks; a mouse move switches back', () => {
    const b = document.createElement('button');
    make().describe(b, 'Approve');
    hint.rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    hint.input({ type: 'keydown', key: 'Enter', repeat: false });
    expect(text()).toBe('Press Tab to reach Approve. Pause there before pressing Enter.');
    expect(b.getAttribute('aria-describedby')).toBe('guard-hint');
    hint.input(mouseMove);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
  });

  it('an input seen during the wait changes nothing yet: still “One moment…” until the wait ends', () => {
    make().rendered(true);
    hint.input(tabKey);
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.keyboard('the button'));
  });

  it('nothing to say: nothing to answer, a screen without a guarded button, or one held back for another reason', () => {
    make().rendered(false);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe('');
    hint.active(true);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
    hint.active(false);
    expect(text()).toBe('');
    hint.active(true);
    hint.cleared();
    expect(text()).toBe('');
    vi.advanceTimersByTime(GUARD_DELAY_MS * 5);
    expect(text()).toBe('');
  });

  it('a quick focus change doesn’t flicker the line; a longer one says to come back, then waits, then the action', () => {
    make().rendered(true);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
    hint.blurred();
    vi.advanceTimersByTime(AWAY_MS - 1);
    hint.focused();
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
    hint.blurred();
    vi.advanceTimersByTime(AWAY_MS);
    expect(text()).toBe('Click or tap this window to continue.');
    hint.focused();
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
  });

  it('a window opened without focus says to come back at once; focus, the wait, then the action', () => {
    make(false, null).rendered(true);
    expect(text()).toBe(GUARD_HINT_TEXT.away);
    vi.advanceTimersByTime(GUARD_DELAY_MS * 3);
    expect(text()).toBe(GUARD_HINT_TEXT.away);
    hint.focused();
    expect(text()).toBe(GUARD_HINT_TEXT.wait);
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    expect(text()).toBe(GUARD_HINT_TEXT.mouse);
  });

  it('display only: a plain paragraph, not focusable, not a button, not a live region; its words are text', () => {
    make().rendered(true);
    expect(hint.el.tagName).toBe('P');
    expect(hint.el.className).toBe('guard-hint muted');
    expect(hint.el.id).toBe('guard-hint');
    expect(hint.el.hasAttribute('tabindex')).toBe(false);
    expect(hint.el.hasAttribute('role')).toBe(false);
    expect(hint.el.hasAttribute('aria-live')).toBe(false);
    expect(hint.el.children).toHaveLength(0);
  });

  it('the input of an event: touch and pen, mouse, keyboard; anything else unknown', () => {
    expect(inputKind(touchDown)).toBe('touch');
    expect(inputKind({ type: 'pointermove', pointerType: 'pen' })).toBe('touch');
    expect(inputKind(mouseMove)).toBe('mouse');
    expect(inputKind(tabKey)).toBe('keyboard');
    expect(inputKind({ type: 'pointerdown' })).toBeNull();
    expect(coarsePointer({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(coarsePointer({})).toBe(false);
    expect(coarsePointer({ matchMedia: () => { throw new Error('no'); } })).toBe(false);
  });

  it('its space is kept (two lines) so no button moves when it appears or goes', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'auth', 'css', 'base.css'), 'utf8');
    expect(css).toMatch(/p\.guard-hint \{[^}]*min-height: calc\(2 \* var\(--jp-leading-body\) \* var\(--jp-text-sm\)\);/u);
  });
});

describe('the guard itself is unchanged by D878', () => {
  it('approve-guard.ts is byte for byte the file D36 and D113 shaped (a change to it is a guard change: its own decision)', () => {
    const file = readFileSync(join(process.cwd(), 'src', 'auth', 'approve-guard.ts'));
    expect(createHash('sha256').update(file).digest('hex')).toBe('7a7cc551c823d4ac3c5db10a6627d41aec4c932d63c3306beace0b9330f9a242');
  });
});
