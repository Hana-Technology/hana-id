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

/** The vault iframe's name, `hana-vault-<32 hex>` (128-bit random, set by the SDK). */
export const VAULT_FRAME_NAME = /^hana-vault-[0-9a-f]{32}$/u;

/** Child frame `name` of `w`, or null (cross-origin named access to child frames is allowed; anything odd is null). */
export function childFrame(w: Window, name: string): unknown {
  try {
    return (w.frames as unknown as Record<string, unknown>)[name] ?? null;
  } catch {
    return null;
  }
}

/** `w.parent`, or null when it can't be read. */
export function parentOf(w: unknown): unknown {
  try {
    return (w as Window).parent;
  } catch {
    return null;
  }
}

/**
 * Whether a message came from the partner page's vault frame: `event.origin` is vaultOrigin, `event.source` is
 * `opener.frames[vaultFrame]`, and that frame's parent is the opener. The login and approval popups opened by the
 * partner page (`?v=<vault frame name>`) authenticate the vault this way.
 */
export function fromPartnerVault(e: MessageEvent, opener: Window, vaultFrame: string, vaultOrigin: string): boolean {
  if (e.origin !== vaultOrigin) return false;
  const vault = childFrame(opener, vaultFrame);
  return vault !== null && e.source === vault && parentOf(e.source) === opener;
}

/** 128-bit random window-name suffix, 32 lowercase hex characters. */
export function randomName(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** The isTrusted check, injectable so tests can simulate a real user gesture. */
export type GestureCheck = (event: Event) => boolean;
export const isUserGesture: GestureCheck = (event) => event.isTrusted;
