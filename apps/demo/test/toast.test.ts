// @vitest-environment happy-dom
// The toasts (src/toast.ts, the design system's pattern): 5 s, paused while hovered, a stack of three, a danger toast
// that stays until dismissed, a dismiss button, text nodes only.
import { beforeEach, describe, expect, it } from 'vitest';
import { TOAST_MAX, TOAST_MS, type Timers, createToaster } from '../src/toast.ts';

/** Timers driven by hand: `advance(ms)` runs what is due. */
function manualTimers(): Timers & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      due.delete(id as number);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const first = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = until;
    },
  };
}

let stack: HTMLElement;
let timers: ReturnType<typeof manualTimers>;

beforeEach(() => {
  document.body.innerHTML = '<div id="toasts"></div>';
  stack = document.getElementById('toasts')!;
  timers = manualTimers();
});

const live = () => [...stack.children].filter((c) => !c.classList.contains('out'));

describe('toasts', () => {
  it('shows a title and a line, with the tone, an icon, a dismiss button and a polite role', () => {
    const t = createToaster(stack, timers).show('success', 'Copied', 'EVM address on the clipboard.');
    expect(t.className).toBe('jp-toast jp-toast-success');
    expect(t.getAttribute('role')).toBe('status');
    expect(t.querySelector('.tx b')!.textContent).toBe('Copied');
    expect(t.querySelector('.tx span')!.textContent).toBe('EVM address on the clipboard.');
    expect(t.querySelector('svg use')!.getAttribute('href')).toBe('#i-check-c');
    expect(t.querySelector('button.x')!.getAttribute('aria-label')).toBe('Dismiss');
    expect(t.querySelector('.bar')).not.toBeNull();
  });

  it('goes after 5 seconds, leaving the DOM after its exit animation', () => {
    const t = createToaster(stack, timers).show('info', 'Export window open');
    timers.advance(TOAST_MS - 1);
    expect(t.classList.contains('out')).toBe(false);
    timers.advance(1);
    expect(t.classList.contains('out')).toBe(true);
    expect(stack.contains(t)).toBe(true);
    timers.advance(500);
    expect(stack.contains(t)).toBe(false);
  });

  it('pauses while the pointer is on it, then runs out the time it had left', () => {
    const t = createToaster(stack, timers).show('success', 'Logged out');
    timers.advance(3000);
    t.dispatchEvent(new Event('mouseenter'));
    timers.advance(60_000);
    expect(t.classList.contains('out')).toBe(false);
    t.dispatchEvent(new Event('mouseleave'));
    timers.advance(1999);
    expect(t.classList.contains('out')).toBe(false);
    timers.advance(1);
    expect(t.classList.contains('out')).toBe(true);
  });

  it('a danger toast stays until dismissed, and interrupts (role alert)', () => {
    const t = createToaster(stack, timers).show('danger', 'Signature refused', 'Nothing was sent.');
    expect(t.getAttribute('role')).toBe('alert');
    expect(t.querySelector('.bar')).toBeNull();
    timers.advance(10 * 60_000);
    expect(live()).toEqual([t]);
    (t.querySelector('button.x') as HTMLButtonElement).click();
    expect(t.classList.contains('out')).toBe(true);
    timers.advance(500);
    expect(stack.children).toHaveLength(0);
  });

  it('keeps a stack of three: a fourth pushes out the oldest', () => {
    const toaster = createToaster(stack, timers);
    const shown = ['one', 'two', 'three', 'four'].map((title) => toaster.show('info', title));
    expect(TOAST_MAX).toBe(3);
    expect(live()).toEqual(shown.slice(1));
  });

  it('sets text, never markup', () => {
    const t = createToaster(stack, timers).show('info', '<img src=x onerror=alert(1)>', '<b>bold</b>');
    expect(t.querySelectorAll('img, .tx span b')).toHaveLength(0);
    expect(t.querySelector('.tx b')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
