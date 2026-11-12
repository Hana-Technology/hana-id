// @vitest-environment happy-dom
// Passport Home's toasts (toast.ts, D765): at most three at once, gone after 5 s, a danger toast stays until dismissed,
// a Dismiss button on each, text only, and one live region outside the page's content.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { TOAST_MAX, TOAST_MS, toaster } from '../../src/auth/toast.ts';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => vi.useRealTimers());

const shown = (root: HTMLElement): string[] => [...root.querySelectorAll('.jp-toast b')].map((b) => b.textContent ?? '');

describe('toasts', () => {
  it('a polite live region holds them: the system’s stack, each toast with its tone, icon, title, text and Dismiss', () => {
    const t = toaster(dom(document));
    document.body.append(t.root);
    expect(t.root.classList.contains('jp-toast-stack')).toBe(true);
    expect(t.root.getAttribute('aria-live')).toBe('polite');
    const el = t.show({ tone: 'success', title: 'Copied the Stellar address.', text: 'More words' });
    expect(el.classList.contains('jp-toast-success')).toBe(true);
    expect(el.getAttribute('role')).toBe('status');
    expect(el.querySelector('svg.ic')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.tx b')?.textContent).toBe('Copied the Stellar address.');
    expect(el.querySelector('.tx span')?.textContent).toBe('More words');
    expect(el.querySelector('button.x')?.getAttribute('aria-label')).toBe('Dismiss');
  });

  it(`goes by itself after ${TOAST_MS} ms`, () => {
    const t = toaster(dom(document));
    t.show({ tone: 'info', title: 'one' });
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(shown(t.root)).toEqual(['one']);
    vi.advanceTimersByTime(1);
    expect(shown(t.root)).toEqual([]);
  });

  it('a danger toast stays until it is dismissed, and is an alert', () => {
    const t = toaster(dom(document));
    const el = t.show({ tone: 'danger', title: 'bad' });
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.querySelector('.bar')).toBeNull();
    vi.advanceTimersByTime(TOAST_MS * 20);
    expect(shown(t.root)).toEqual(['bad']);
    (el.querySelector('button.x') as HTMLButtonElement).click();
    expect(shown(t.root)).toEqual([]);
  });

  it(`shows at most ${TOAST_MAX}: a new one pushes the oldest out`, () => {
    const t = toaster(dom(document));
    for (const n of ['1', '2', '3', '4']) t.show({ tone: 'success', title: n });
    expect(shown(t.root)).toEqual(['2', '3', '4']);
    // The one pushed out leaves no timer behind: the others still go on time.
    vi.advanceTimersByTime(TOAST_MS);
    expect(shown(t.root)).toEqual([]);
  });

  it('Dismiss removes that toast at once; clear removes them all', () => {
    const t = toaster(dom(document));
    const a = t.show({ tone: 'success', title: 'a' });
    t.show({ tone: 'danger', title: 'b' });
    (a.querySelector('button.x') as HTMLButtonElement).click();
    expect(shown(t.root)).toEqual(['b']);
    t.show({ tone: 'warning', title: 'c' });
    t.clear();
    expect(shown(t.root)).toEqual([]);
  });

  it('text is text: markup in a title never becomes an element', () => {
    const t = toaster(dom(document));
    t.show({ tone: 'info', title: '<img src=x onerror="__pwned=1">' });
    expect(t.root.querySelector('img')).toBeNull();
    expect(shown(t.root)).toEqual(['<img src=x onerror="__pwned=1">']);
  });
});
