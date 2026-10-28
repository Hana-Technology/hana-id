// The part of `window` the auth pages use, so tests can drive them with a fake window (opener, frames, messages)
// over a real DOM. In a browser the entries pass `window` itself.

export interface PageWindow {
  readonly document: Document;
  readonly location: { readonly search: string; readonly hash: string; readonly pathname: string; assign(url: string): void };
  readonly history: { replaceState(data: unknown, unused: string, url?: string | null): void };
  readonly sessionStorage: Storage;
  readonly opener: Window | null;
  readonly top: unknown;
  readonly name: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  open(url: string, target: string, features: string): Window | null;
  close(): void;
}

/** True when the page runs inside a frame (every auth page refuses to; frame-ancestors 'none' also blocks it). */
export function isFramed(win: PageWindow): boolean {
  try {
    return win.top !== win;
  } catch {
    return true;
  }
}

/** 128-bit random window-name suffix, 32 lowercase hex characters. */
export function randomName(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** The isTrusted check, injectable so tests can simulate a real user gesture. */
export type GestureCheck = (event: Event) => boolean;
export const isUserGesture: GestureCheck = (event) => event.isTrusted;
