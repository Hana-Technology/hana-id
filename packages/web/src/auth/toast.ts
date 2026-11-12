// Passport Home's toasts (D765, the design system's toast pattern): a short outcome the user doesn't have to act on
// ("Copied the Stellar address."). They sit bottom-right on a desktop and at the top on a phone (css/home.css), at most
// 380 px wide, at most three at once (a fourth pushes the oldest out), and go by themselves after 5 s, except a danger
// toast, which stays until it is dismissed. Each has a Dismiss button. Anything the user must act on is an inline alert
// instead, never a toast.
//
// The stack is one element made at start and kept outside the page's content (`#app` is redrawn; the stack isn't), with
// `aria-live="polite"` so a screen reader reads each toast once as it appears. Text goes in as text nodes only.
import type { Dom } from './dom.ts';
import { type IconName, icon } from './ui.ts';

/** How long a toast stays, unless it is a danger toast. */
export const TOAST_MS = 5000;
/** How many toasts show at once. */
export const TOAST_MAX = 3;

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';
const TONE_ICON: Readonly<Record<ToastTone, IconName>> = Object.freeze({ success: 'check-c', info: 'info', warning: 'warn', danger: 'warn' });

export interface ToastTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface Toaster {
  /** The stack element (put once in the page, outside the redrawn content). */
  readonly root: HTMLElement;
  /** Shows a toast; returns its element. */
  show(t: { tone: ToastTone; title: string; text?: string }): HTMLElement;
  /** Removes every toast (a sign-out). */
  clear(): void;
}

export function toaster(d: Dom, timers: ToastTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) }): Toaster {
  const root = d.h('div', { class: 'jp-toast-stack home-toasts', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions' } });
  const live: { el: HTMLElement; timer: unknown }[] = [];

  const remove = (el: HTMLElement): void => {
    const i = live.findIndex((t) => t.el === el);
    if (i < 0) return;
    const [t] = live.splice(i, 1);
    if (t && t.timer !== null) timers.clearTimeout(t.timer);
    el.remove();
  };

  return {
    root,
    show({ tone, title, text }) {
      const dismiss = d.h('button', { class: 'x', attrs: { type: 'button', 'aria-label': 'Dismiss' } }, icon(d, 'x'));
      const el = d.h(
        'div',
        { class: `jp-toast jp-toast-${tone}`, attrs: { role: tone === 'danger' ? 'alert' : 'status' } },
        icon(d, TONE_ICON[tone]),
        d.h('div', { class: 'tx' }, d.h('b', {}, title), text ? d.h('span', {}, text) : null),
        dismiss,
        // The bar shows the 5 s running out; a danger toast has none.
        tone === 'danger' ? null : d.h('i', { class: 'bar', attrs: { 'aria-hidden': 'true' } }),
      );
      dismiss.addEventListener('click', () => remove(el));
      const timer = tone === 'danger' ? null : timers.setTimeout(() => remove(el), TOAST_MS);
      live.push({ el, timer });
      root.append(el);
      while (live.length > TOAST_MAX) remove((live[0] as { el: HTMLElement }).el);
      return el;
    },
    clear() {
      for (const t of [...live]) remove(t.el);
    },
  };
}
