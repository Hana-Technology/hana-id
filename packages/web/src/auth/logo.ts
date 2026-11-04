// The app's logo beside its name on the auth pages (batch C11; docs/batch-c-spec.md "Other app settings, name and
// logo"). Shown only from the files origin this build pins (core logoUrlOn), which is also the only other origin in
// these pages' `img-src` (pages.ts imgSources; the Worker's header policy matches). Decorative: `alt=""` (the name
// beside it is the text), and an image that fails to load is removed, so a missing logo leaves the name alone.
import { logoUrlOn } from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import type { Dom } from './dom.ts';

/** The logo's size on screen, in CSS pixels (the stored PNG is 256 × 256). */
export const LOGO_PX = 32;

/** An `<img>` for the app's logo, or null when there is none to show (no logo, another origin, no files origin). */
export function appLogo(d: Dom, env: Pick<HanaEnv, 'filesOrigin'>, logoUrl: unknown): HTMLImageElement | null {
  const src = logoUrlOn(env.filesOrigin, logoUrl);
  if (!src) return null;
  const img = d.h('img', {
    class: 'app-logo',
    attrs: { src, alt: '', width: String(LOGO_PX), height: String(LOGO_PX), referrerpolicy: 'no-referrer', decoding: 'async' },
  });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}
