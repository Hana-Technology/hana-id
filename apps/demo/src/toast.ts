// Toasts (the design system's pattern): a transient result (an address copied, a logout, an export window opened),
// never an error the user must act on (those are inline alerts, page.ts). Bottom right on desktop and at the top on
// phones (style.css), 380 px at most, a stack of three (the oldest goes first), each dismissed after 5 s, a timer that
// pauses while the pointer is on it, except a danger toast, which stays until dismissed. Built with DOM calls only
// (the page's Trusted Types policy allows no HTML strings).

export type ToastTone = 'success' | 'info' | 'warning' | 'danger' | 'accent';

/** How long a toast stays (the system's 5 s, the length of its progress bar's animation in components.css). */
export const TOAST_MS = 5000;
/** The stack's height: a fourth toast pushes out the oldest. */
export const TOAST_MAX = 3;
/** Its exit animation (components.css `.jp-toast.out`, --jp-dur-base), before it leaves the DOM. */
const EXIT_MS = 200;

const ICON: Record<ToastTone, string> = { success: 'i-check-c', info: 'i-info', warning: 'i-warn', danger: 'i-x-c', accent: 'i-bolt' };

const SVG = 'http://www.w3.org/2000/svg';

/** An icon from the page's sprite (index.html), hidden from assistive technology. */
export function icon(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Monotonic ms. */
  now(): number;
}

export interface Toaster {
  /** Shows a toast: a bold title and an optional line under it. */
  show(tone: ToastTone, title: string, body?: string): HTMLElement;
}

export function createToaster(stack: HTMLElement, timers: Timers): Toaster {
  function remove(t: HTMLElement): void {
    if (t.classList.contains('out')) return;
    t.classList.add('out');
    timers.setTimeout(() => t.remove(), EXIT_MS);
  }

  return {
    show(tone, title, body) {
      const t = document.createElement('div');
      t.className = `jp-toast jp-toast-${tone}`;
      // A danger toast interrupts (and stays); the others are announced politely.
      t.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
      const tx = document.createElement('div');
      tx.className = 'tx';
      const b = document.createElement('b');
      b.textContent = title;
      tx.append(b);
      if (body) {
        const s = document.createElement('span');
        s.textContent = body;
        tx.append(s);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.setAttribute('aria-label', 'Dismiss');
      x.append(icon('i-x'));
      x.addEventListener('click', () => remove(t));
      t.append(icon(ICON[tone]), tx, x);

      if (tone !== 'danger') {
        const bar = document.createElement('span');
        bar.className = 'bar';
        t.append(bar);
        // The timer pauses on hover, as the bar does (components.css).
        let left = TOAST_MS;
        let startedAt = 0;
        let timer: unknown = null;
        const start = (): void => {
          startedAt = timers.now();
          timer = timers.setTimeout(() => remove(t), left);
        };
        t.addEventListener('mouseenter', () => {
          if (timer === null) return;
          timers.clearTimeout(timer);
          timer = null;
          left = Math.max(0, left - (timers.now() - startedAt));
        });
        t.addEventListener('mouseleave', () => {
          if (timer === null && !t.classList.contains('out')) start();
        });
        start();
      }

      stack.append(t);
      const live = [...stack.children].filter((c) => !c.classList.contains('out'));
      for (const old of live.slice(0, Math.max(0, live.length - TOAST_MAX))) old.remove();
      return t;
    },
  };
}
